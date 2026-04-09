const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// ─── clients ───────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ─── constants ─────────────────────────────────────────────────────────────
const POSITIONS = ['P1', 'P2', 'P3', 'P4'];

const POSITION_EMOJI = {
  P1: '🎮',
  P2: '🎮',
  P3: '🎮',
  P4: '🎮',
};

// position label colors in embed (using unicode bold)
const POSITION_LABEL = {
  P1: '🔵 P1',
  P2: '🟢 P2',
  P3: '🟡 P3',
  P4: '🔴 P4',
};

// LFG 訊息監聽用（保留原有功能）
const BOSS_ALIASES = {
  heatran: 'Heatran', cresselia: 'Cresselia', meloetta: 'Meloetta',
  cobalion: 'Cobalion', terrakion: 'Terrakion', virizion: 'Virizion',
  octi: 'Heatran', octilleri: 'Heatran', octillery: 'Heatran',
};

const SERVER_CONFIGS = {
  [process.env.SERVER_A_ID]: { type: 'split' },
  [process.env.SERVER_B_ID]: {
    type: 'single',
    channelIds: (process.env.SERVER_B_CHANNEL_IDS || '').split(',').filter(Boolean),
  },
};

// ─── keyword cache ──────────────────────────────────────────────────────────
let keywordsCache = [];
let keywordsCacheTime = 0;

async function getKeywords() {
  if (Date.now() - keywordsCacheTime < 5 * 60 * 1000) return keywordsCache;
  const { data } = await supabase.from('lfg_keywords').select('*');
  keywordsCache = data || [];
  keywordsCacheTime = Date.now();
  return keywordsCache;
}

// ─── raid / team cache ──────────────────────────────────────────────────────
let raidsCache = [];
let teamsCache = [];
let configCacheTime = 0;

async function getRaidConfig() {
  if (Date.now() - configCacheTime < 60 * 1000) return { raidsCache, teamsCache };
  const { data: raids } = await supabase.from('raids').select('*').order('sort_order');
  const { data: teams } = await supabase.from('teams').select('*').order('id');
  raidsCache = raids || [];
  teamsCache = teams || [];
  configCacheTime = Date.now();
  return { raidsCache, teamsCache };
}

// ─── helpers ────────────────────────────────────────────────────────────────
function bossByText(text) {
  const lower = text.toLowerCase();
  for (const [alias, boss] of Object.entries(BOSS_ALIASES)) {
    if (lower.includes(alias)) return boss;
  }
  return null;
}

function parsePositions(content) {
  const lower = content.toLowerCase();
  if (/every\s*pos|all\s*pos|any\s*pos/i.test(lower)) return ['P1', 'P2', 'P3', 'P4'];
  const positions = [];
  for (const m of lower.matchAll(/p\s*([1-4])/g)) {
    const p = `P${m[1]}`;
    if (!positions.includes(p)) positions.push(p);
  }
  return positions;
}

function parseIGN(content, displayName) {
  const ignMatch = content.match(/ign\s*:?\s*(\S+)/i);
  if (ignMatch) return ignMatch[1];
  return displayName;
}

// ─── build strat embed + buttons ───────────────────────────────────────────
async function buildStratMessage(raidName, teamName, signups = {}, creatorId = null, viewerId = null) {
  // signups = { P1: [...] | {game_id,discord_username} | null }
  const embed = new EmbedBuilder()
    .setTitle(`📋 ${raidName} — ${teamName}`)
    .setColor(0x5865f2)
    .setDescription(
      POSITIONS.map(pos => {
        const label = POSITION_LABEL[pos];
        // collect all signups for this position
        const posSignups = Array.isArray(signups[pos]) ? signups[pos] : (signups[pos] ? [signups[pos]] : []);
        if (posSignups.length > 0) {
          return posSignups.map(s => `🎮 **${pos}** | ${s.game_id} ✅`).join('\n');
        }
        return `🎮 **${pos}** | Open`;
      }).join('\n')
    )
    .setFooter({ text: 'Click a button to sign up · Run /id to link your game account' })
    .setTimestamp();

  // row1: P1 P2 P3 P4 + Cancel
  const signupButtons = POSITIONS.map(pos => {
    const posSignups = Array.isArray(signups[pos]) ? signups[pos] : (signups[pos] ? [signups[pos]] : []);
    const iJoined = viewerId && posSignups.some(s => s.discord_id === viewerId);
    return new ButtonBuilder()
      .setCustomId(`signup:${pos}`)
      .setLabel(iJoined ? `${pos} ✅` : `Join ${pos}`)
      .setStyle(iJoined ? ButtonStyle.Success : ButtonStyle.Primary);
  });

  const cancelBtn = new ButtonBuilder()
    .setCustomId('signup:cancel')
    .setLabel('Cancel')
    .setStyle(ButtonStyle.Danger);

  const row1 = new ActionRowBuilder().addComponents([...signupButtons, cancelBtn]);

  // row2: Delete (creator only) — only shown when we know viewer is creator
  const isCreator = creatorId && viewerId && creatorId === viewerId;
  if (isCreator) {
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('post:delete')
        .setLabel('🗑 Delete Post')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('post:kick')
        .setLabel('👢 Kick')
        .setStyle(ButtonStyle.Secondary),
    );
    return { embeds: [embed], components: [row1, row2] };
  }

  return { embeds: [embed], components: [row1] };
}

// 從 DB 讀取當前 strat_post 的報名狀態（每個 position 可多人）
async function getSignupsForPost(stratPostId) {
  const { data } = await supabase
    .from('discord_signups')
    .select('position, game_id, discord_username, discord_id')
    .eq('strat_post_id', stratPostId);

  // signups[pos] = array of { game_id, discord_username, discord_id }
  const signups = {};
  for (const row of data || []) {
    if (!signups[row.position]) signups[row.position] = [];
    signups[row.position].push({ game_id: row.game_id, discord_username: row.discord_username, discord_id: row.discord_id });
  }
  return signups;
}

// ─── slash command registration ─────────────────────────────────────────────
async function registerCommands() {
  const commands = [
    // /id — 綁定遊戲 ID
    new SlashCommandBuilder()
      .setName('id')
      .setDescription('Link or view your PokéMMO game ID')
      .addStringOption(opt =>
        opt.setName('game_id')
          .setDescription('Your PokéMMO in-game name (leave blank to view current)')
          .setRequired(false)
      ),

    // /raid — post a raid signup form
    new SlashCommandBuilder()
      .setName('raid')
      .setDescription('Post a raid signup form')
      .addStringOption(opt =>
        opt.setName('raid')
          .setDescription('Select a raid boss')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption(opt =>
        opt.setName('team')
          .setDescription('Select a team strategy')
          .setRequired(true)
          .setAutocomplete(true)
      ),

    // /delete — delete your own raid post
    new SlashCommandBuilder()
      .setName('delete')
      .setDescription('Delete a raid post you created')
      .addStringOption(opt =>
        opt.setName('message_id')
          .setDescription('Message ID of the raid post (right-click → Copy Message ID)')
          .setRequired(true)
      ),

    // /position — join a position on the website player list
    new SlashCommandBuilder()
      .setName('position')
      .setDescription('Join a position on the website player list')
      .addStringOption(opt =>
        opt.setName('raid')
          .setDescription('Select a raid boss')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption(opt =>
        opt.setName('team')
          .setDescription('Select a team strategy')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption(opt =>
        opt.setName('position')
          .setDescription('Select your position')
          .setRequired(true)
          .addChoices(
            { name: 'P1', value: 'P1' },
            { name: 'P2', value: 'P2' },
            { name: 'P3', value: 'P3' },
            { name: 'P4', value: 'P4' },
          )
      ),
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
    // 全局 command 需要最多 1 小時才能生效
    // 用 guild command 測試時改用 guildId
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID),
      { body: commands }
    );
    console.log('[Bot] Slash commands registered');
  } catch (err) {
    console.error('[Bot] Failed to register commands:', err.message);
  }
}

// ─── event: ready ───────────────────────────────────────────────────────────
client.once('ready', () => {
  console.log(`[Bot] Ready: ${client.user.tag}`);
  setInterval(markStale, 10 * 60 * 1000);
});

// ─── event: autocomplete ────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isAutocomplete()) return;

  const { raidsCache, teamsCache } = await getRaidConfig();

  if (interaction.commandName === 'raid' || interaction.commandName === 'position') {
    const focused = interaction.options.getFocused(true);

    if (focused.name === 'raid') {
      const choices = raidsCache
        .filter(r => r.name.toLowerCase().includes(focused.value.toLowerCase()))
        .slice(0, 25)
        .map(r => ({ name: `${r.icon} ${r.name}`, value: String(r.id) }));
      await interaction.respond(choices);
    }

    if (focused.name === 'team') {
      const raidId = interaction.options.getString('raid');
      const choices = teamsCache
        .filter(t =>
          (!raidId || String(t.raid_id) === raidId) &&
          t.name.toLowerCase().includes(focused.value.toLowerCase())
        )
        .slice(0, 25)
        .map(t => ({ name: t.name, value: String(t.id) }));
      await interaction.respond(choices);
    }
  }
});

// ─── event: slash commands + buttons ────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  // ── /id ───────────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'id') {
    const gameId = interaction.options.getString('game_id');
    const discordId = interaction.user.id;
    const discordUsername = interaction.member?.nickname || interaction.user.globalName || interaction.user.username;

    if (!gameId) {
      // 查詢
      const { data } = await supabase
        .from('user_bindings')
        .select('game_id, updated_at')
        .eq('discord_id', discordId)
        .single();

      if (!data) {
        await interaction.reply({
          content: '❌ No game ID linked.\nRun `/id <your_game_id>` to link one.',
          ephemeral: true,
        });
      } else {
        await interaction.reply({
          content: `✅ Linked game ID: **${data.game_id}**\nRun \`/id <new_id>\` to update.`,
          ephemeral: true,
        });
      }
      return;
    }

    // 綁定 / 更新
    const { error } = await supabase.from('user_bindings').upsert({
      discord_id: discordId,
      discord_username: discordUsername,
      game_id: gameId,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'discord_id' });

    if (error) {
      await interaction.reply({ content: '❌ Failed to link game ID. Please try again.', ephemeral: true });
    } else {
      await interaction.reply({
        content: `✅ Linked! Game ID: **${gameId}**\nYou can now click buttons on raid posts to sign up.`,
        ephemeral: true,
      });
    }
    return;
  }

  // ── /strat ────────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'raid') {
    const raidId = parseInt(interaction.options.getString('raid'));
    const teamId = parseInt(interaction.options.getString('team'));

    const { raidsCache, teamsCache } = await getRaidConfig();
    const raid = raidsCache.find(r => r.id === raidId);
    const team = teamsCache.find(t => t.id === teamId);

    if (!raid || !team) {
      await interaction.reply({ content: '❌ Raid or strategy not found.', ephemeral: true });
      return;
    }

    await interaction.deferReply();

    const msgPayload = await buildStratMessage(raid.name, team.name, {});
    const msg = await interaction.followUp(msgPayload);

    // 存入 strat_posts
    const { data: stratPost, error } = await supabase
      .from('strat_posts')
      .insert({
        message_id: msg.id,
        channel_id: interaction.channelId,
        guild_id: interaction.guildId,
        raid_id: raidId,
        team_id: teamId,
        created_by_discord_id: interaction.user.id,
      })
      .select()
      .single();

    if (error) {
      console.error('[Bot] strat_posts insert error:', error.message);
    } else {
      console.log(`[Bot] Strat post created: ${stratPost.id} | ${raid.name} ${team.name}`);
    }
    return;
  }

  // ── /delete ───────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'delete') {
    const messageId = interaction.options.getString('message_id');
    const discordId = interaction.user.id;

    // find the strat post and verify the requester created it
    const { data: stratPost } = await supabase
      .from('strat_posts')
      .select('*')
      .eq('message_id', messageId)
      .single();

    if (!stratPost) {
      await interaction.reply({ content: '❌ Raid post not found.', ephemeral: true });
      return;
    }

    // only the original poster (matched by guild + channel) can delete
    // we store created_by_discord_id if available, else allow anyone in same guild
    const channel = interaction.guild?.channels?.cache.get(stratPost.channel_id);
    try {
      const msg = await channel?.messages?.fetch(messageId);
      if (msg) await msg.delete();
    } catch (e) {
      console.error('[Bot] Failed to delete message:', e.message);
    }

    // clean up DB
    await supabase.from('discord_signups').delete().eq('strat_post_id', stratPost.id);
    await supabase.from('strat_posts').delete().eq('id', stratPost.id);

    await interaction.reply({ content: '✅ Raid post deleted.', ephemeral: true });
    return;
  }

  // ── /position ─────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'position') {
    const raidId  = parseInt(interaction.options.getString('raid'));
    const teamId  = parseInt(interaction.options.getString('team'));
    const position = interaction.options.getString('position');
    const discordId = interaction.user.id;
    const discordUsername = interaction.member?.nickname || interaction.user.globalName || interaction.user.username;

    // check game ID binding
    const { data: binding } = await supabase
      .from('user_bindings')
      .select('game_id')
      .eq('discord_id', discordId)
      .single();

    if (!binding) {
      await interaction.reply({ content: '❌ No game ID linked.\nRun `/id <your_game_id>` first.', ephemeral: true });
      return;
    }

    const { raidsCache, teamsCache } = await getRaidConfig();
    const raid = raidsCache.find(r => r.id === raidId);
    const team = teamsCache.find(t => t.id === teamId);

    if (!raid || !team) {
      await interaction.reply({ content: '❌ Raid or strategy not found.', ephemeral: true });
      return;
    }

    const now = new Date().toISOString();

    // upsert into players table — offline by default, shows last_seen
    const { error } = await supabase.from('players').upsert({
      boss_name: raid.name,
      team_id: teamId,
      position,
      player_name: binding.game_id,
      online: false,
      last_seen: now,
      joined_at: now,
    }, { onConflict: 'boss_name,team_id,position,player_name' });

    if (error) {
      await interaction.reply({ content: '❌ Failed to join position. Please try again.', ephemeral: true });
      console.error('[Bot] /position error:', error.message);
      return;
    }

    await interaction.reply({
      content: `✅ Joined **${position}** for **${raid.name} — ${team.name}**!\nGame ID: ${binding.game_id} (offline by default — go online on the website)`,
      ephemeral: true,
    });
    console.log(`[/position] ${binding.game_id} → ${raid.name} ${team.name} ${position}`);
    return;
  }

  // ── buttons ───────────────────────────────────────────────────────────────
  if (!interaction.isButton()) return;

  const [action, value] = interaction.customId.split(':');
  const discordId = interaction.user.id;
  const discordUsername = interaction.member?.nickname || interaction.user.globalName || interaction.user.username;

  // find strat post
  const { data: stratPost } = await supabase
    .from('strat_posts')
    .select('*, raids(name, icon), teams(name)')
    .eq('message_id', interaction.message.id)
    .single();

  if (!stratPost) return;

  const raidName = stratPost.raids?.name || 'Raid';
  const teamName = stratPost.teams?.name || 'Strat';
  const creatorId = stratPost.created_by_discord_id || null;

  // ── post:delete (creator only) ────────────────────────────────────────────
  if (action === 'post' && value === 'delete') {
    if (discordId !== creatorId) {
      await interaction.reply({ content: '❌ Only the post creator can delete this.', ephemeral: true });
      return;
    }
    try { await interaction.message.delete(); } catch (e) {}
    await supabase.from('discord_signups').delete().eq('strat_post_id', stratPost.id);
    await supabase.from('strat_posts').delete().eq('id', stratPost.id);
    await interaction.reply({ content: '✅ Post deleted.', ephemeral: true });
    return;
  }

  // ── post:kick (creator only) ──────────────────────────────────────────────
  if (action === 'post' && value === 'kick') {
    if (discordId !== creatorId) {
      await interaction.reply({ content: '❌ Only the post creator can kick players.', ephemeral: true });
      return;
    }
    // show current signups so creator can pick who to kick
    const signups = await getSignupsForPost(stratPost.id);
    const allSignups = Object.entries(signups).flatMap(([pos, arr]) =>
      (Array.isArray(arr) ? arr : [arr]).map(s => `${pos}: ${s.game_id}`)
    );
    if (allSignups.length === 0) {
      await interaction.reply({ content: 'No signups to kick.', ephemeral: true });
      return;
    }
    await interaction.reply({
      content: `**Current signups:**\n${allSignups.join('\n')}\n\nUse \`/kick <game_id>\` to remove a player (coming soon).`,
      ephemeral: true,
    });
    return;
  }

  // all remaining actions require game ID binding
  if (action !== 'signup') return;

  const { data: binding } = await supabase
    .from('user_bindings')
    .select('game_id')
    .eq('discord_id', discordId)
    .single();

  if (!binding) {
    await interaction.reply({
      content: '❌ No game ID linked.\nRun `/id <your_game_id>` first.',
      ephemeral: true,
    });
    return;
  }

  // ── signup:cancel — remove ALL of this user's signups from this post ──────
  if (value === 'cancel') {
    const { data: oldSignups } = await supabase
      .from('discord_signups')
      .select('position')
      .eq('strat_post_id', stratPost.id)
      .eq('discord_id', discordId);

    await supabase
      .from('discord_signups')
      .delete()
      .eq('strat_post_id', stratPost.id)
      .eq('discord_id', discordId);

    // sync: remove from players table
    if (oldSignups?.length && stratPost.raid_id) {
      const { raidsCache } = await getRaidConfig();
      const raid = raidsCache.find(r => r.id === stratPost.raid_id);
      if (raid) {
        for (const s of oldSignups) {
          await supabase.from('players')
            .delete()
            .eq('boss_name', raid.name)
            .eq('team_id', stratPost.team_id)
            .eq('position', s.position)
            .eq('player_name', binding.game_id);
        }
      }
    }

    const signups = await getSignupsForPost(stratPost.id);
    const updated = await buildStratMessage(raidName, teamName, signups, creatorId, discordId);
    await interaction.update(updated);
    await interaction.followUp({ content: '✅ All signups cancelled.', ephemeral: true });
    return;
  }

  // ── signup:P1~P4 — toggle: join if not joined, cancel if already joined ───
  const position = value;

  // check if user already signed up for this position (toggle off)
  const { data: mySignup } = await supabase
    .from('discord_signups')
    .select('id')
    .eq('strat_post_id', stratPost.id)
    .eq('discord_id', discordId)
    .eq('position', position)
    .maybeSingle();

  if (mySignup) {
    // toggle off — remove this position
    await supabase.from('discord_signups').delete().eq('id', mySignup.id);

    // sync remove from players
    const { raidsCache } = await getRaidConfig();
    const raid = raidsCache.find(r => r.id === stratPost.raid_id);
    if (raid) {
      await supabase.from('players')
        .delete()
        .eq('boss_name', raid.name)
        .eq('team_id', stratPost.team_id)
        .eq('position', position)
        .eq('player_name', binding.game_id);
    }

    const signups = await getSignupsForPost(stratPost.id);
    const updated = await buildStratMessage(raidName, teamName, signups, creatorId, discordId);
    await interaction.update(updated);
    await interaction.followUp({ content: `✅ Removed from **${position}**.`, ephemeral: true });
    return;
  }

  // check if position is full (maxPerPos from teams table)
  const { data: teamRow } = await supabase
    .from('teams').select('max_per_pos').eq('id', stratPost.team_id).single();
  const maxPerPos = teamRow?.max_per_pos || 4;

  const { count } = await supabase
    .from('discord_signups')
    .select('id', { count: 'exact', head: true })
    .eq('strat_post_id', stratPost.id)
    .eq('position', position);

  if (count >= maxPerPos) {
    await interaction.reply({
      content: `❌ **${position}** is full (${maxPerPos}/${maxPerPos}).`,
      ephemeral: true,
    });
    return;
  }

  // join this position
  const { error: insertError } = await supabase.from('discord_signups').insert({
    strat_post_id: stratPost.id,
    discord_id: discordId,
    discord_username: discordUsername,
    game_id: binding.game_id,
    position,
  });

  if (insertError) {
    await interaction.reply({ content: '❌ Signup failed. Please try again.', ephemeral: true });
    return;
  }

  // sync to players table
  const { raidsCache: rc } = await getRaidConfig();
  const raidForSync = rc.find(r => r.id === stratPost.raid_id);
  if (raidForSync) {
    const now = new Date().toISOString();
    await supabase.from('players').upsert({
      boss_name: raidForSync.name,
      team_id: stratPost.team_id,
      position,
      player_name: binding.game_id,
      online: false,
      last_seen: now,
      joined_at: now,
    }, { onConflict: 'boss_name,team_id,position,player_name' });
  }

  const signups = await getSignupsForPost(stratPost.id);
  const updated = await buildStratMessage(raidName, teamName, signups, creatorId, discordId);
  await interaction.update(updated);
  await interaction.followUp({
    content: `✅ Joined **${position}**! Game ID: ${binding.game_id}`,
    ephemeral: true,
  });
});

// ─── LFG 訊息監聽（保留原有功能）────────────────────────────────────────────
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  const serverId = message.guildId;
  const config = SERVER_CONFIGS[serverId];
  if (!config) return;

  if (config.type === 'single' && !config.channelIds.includes(message.channelId)) return;

  const content = message.content;
  const lower = content.toLowerCase();
  const hasLFG = /\b(lfg|lf\+?|looking for)\b/i.test(lower);
  if (!hasLFG) return;

  const displayName = message.member?.nickname || message.author.globalName || message.author.username;

  let bossName = null;
  let strat_name = null;

  const kwMatch = await (async () => {
    const keywords = await getKeywords();
    for (const kw of keywords) {
      if (lower.includes(kw.keyword.toLowerCase())) {
        return { bossName: kw.boss_name, stratName: kw.team_id };
      }
    }
    return null;
  })();

  if (kwMatch) {
    bossName = kwMatch.bossName;
    strat_name = kwMatch.stratName;
  } else {
    bossName = bossByText(content);
  }

  if (!bossName) return;

  const positions = parsePositions(content);
  const ign = parseIGN(content, displayName);

  const serverName = message.guild?.name || serverId;
  const channelName = message.channel?.name || message.channelId;
  const jumpUrl = `https://discord.com/channels/${serverId}/${message.channelId}/${message.id}`;

  await supabase.from('lfg_posts').upsert({
    discord_msg_id: message.id,
    discord_server_id: serverId,
    discord_channel_id: message.channelId,
    discord_username: displayName,
    ign,
    boss_name: bossName,
    strat_name,
    positions,
    raw_message: content,
    posted_at: new Date(message.createdTimestamp).toISOString(),
    is_stale: false,
    discord_jump_url: jumpUrl,
    server_name: serverName,
    channel_name: channelName,
  }, { onConflict: 'discord_msg_id' });

  console.log(`[LFG] ${displayName} | ${bossName} | pos: ${positions.join(',')} | ign: ${ign}`);
});

// ─── stale 清理 ─────────────────────────────────────────────────────────────
async function markStale() {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  await supabase
    .from('lfg_posts')
    .update({ is_stale: true })
    .eq('is_stale', false)
    .lt('posted_at', twoHoursAgo);
}

// ─── start ───────────────────────────────────────────────────────────────────
// register commands first, then login — avoids race condition in ready event
registerCommands().then(() => {
  client.login(process.env.DISCORD_TOKEN);
});
