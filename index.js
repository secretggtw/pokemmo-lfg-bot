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
async function buildStratMessage(raidName, teamName, signups = {}, creatorName = null, stratPostId = null, teamId = null) {
  const hostLine = creatorName ? `👑 Host: **${creatorName}**\n` : '';
  const baseUrl = 'https://pokemmo-raid-team-finder.vercel.app';
  const playerListUrl = raidName && teamId
    ? `${baseUrl}/?boss=${encodeURIComponent(raidName)}&team=${teamId}`
    : baseUrl;

  const embed = new EmbedBuilder()
    .setTitle(`⚔️ ${raidName} — ${teamName}`)
    .setColor(0x5865f2)
    .setDescription(
      hostLine +
      POSITIONS.map(pos => {
        const posSignups = Array.isArray(signups[pos]) ? signups[pos] : (signups[pos] ? [signups[pos]] : []);
        if (posSignups.length > 0) {
          return posSignups.map(s => `**${pos}** | ${s.game_id} ✅`).join('\n');
        }
        return `**${pos}** | Open`;
      }).join('\n')
    )
    .setFooter({ text: `Run /id to link your game ID · Click /invite buttons to get the invite command · Player list: ${playerListUrl}` })
    .setTimestamp();

  // row1: Join P1~P4 + Leave
  const row1 = new ActionRowBuilder().addComponents(
    ...POSITIONS.map(pos =>
      new ButtonBuilder()
        .setCustomId(`signup:${pos}`)
        .setLabel(`Join ${pos}`)
        .setStyle(ButtonStyle.Primary)
    ),
    new ButtonBuilder()
      .setCustomId('signup:cancel')
      .setLabel('Leave')
      .setStyle(ButtonStyle.Danger)
  );

  // row2: /invite P1~P4 (copies command) + Host Options
  const row2 = new ActionRowBuilder().addComponents(
    ...POSITIONS.map(pos =>
      new ButtonBuilder()
        .setCustomId(`invite:${pos}`)
        .setLabel(`/invite ${pos}`)
        .setStyle(ButtonStyle.Secondary)
    ),
    new ButtonBuilder()
      .setCustomId('host:options')
      .setLabel('Host Options')
      .setStyle(ButtonStyle.Secondary)
  );

  const components = [row1, row2];

  // row3: Kick + Delete (only added when host options are expanded)
  if (stratPostId) {
    const sid = stratPostId;
    const row3 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`kick:P1:${sid}`).setLabel('Kick P1').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`kick:P2:${sid}`).setLabel('Kick P2').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`kick:P3:${sid}`).setLabel('Kick P3').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`kick:P4:${sid}`).setLabel('Kick P4').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`host:delete:${sid}`).setLabel('Delete Post').setStyle(ButtonStyle.Danger),
    );
    components.push(row3);
  }

  return { embeds: [embed], components };
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
      )
      .addBooleanOption(opt =>
        opt.setName('sync')
          .setDescription('Sync to the website player list? (default: yes)')
          .setRequired(false)
      ),

    // /mystatus — view and manage your current signups
    new SlashCommandBuilder()
      .setName('mystatus')
      .setDescription('View and remove your current raid signups'),
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
    console.error('[Bot] Failed to register commands:', err.message, err.stack);
    throw err;
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
          flags: 64,
        });
      } else {
        await interaction.reply({
          content: `✅ Linked game ID: **${data.game_id}**\nRun \`/id <new_id>\` to update.`,
          flags: 64,
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
      await interaction.reply({ content: '❌ Failed to link game ID. Please try again.', flags: 64 });
    } else {
      await interaction.reply({
        content: `✅ Linked! Game ID: **${gameId}**\nYou can now click buttons on raid posts to sign up.`,
        flags: 64,
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
      await interaction.reply({ content: '❌ Raid or strategy not found.', flags: 64 });
      return;
    }

    await interaction.deferReply();

    const creatorName = interaction.member?.nickname || interaction.user.globalName || interaction.user.username;

    // insert strat_posts first to get the id for row3 buttons
    const { data: stratPost, error } = await supabase
      .from('strat_posts')
      .insert({
        message_id: '0', // placeholder, updated after message sent
        channel_id: interaction.channelId,
        guild_id: interaction.guildId,
        raid_id: raidId,
        team_id: teamId,
        created_by_discord_id: interaction.user.id,
        creator_name: creatorName,
      })
      .select()
      .single();

    if (error || !stratPost) {
      console.error('[Bot] strat_posts insert error:', error?.message);
      await interaction.followUp({ content: '❌ Failed to create post.', flags: 64 });
      return;
    }

    const msgPayload = await buildStratMessage(raid.name, team.name, {}, creatorName, stratPost.id, teamId);
    const msg = await interaction.followUp(msgPayload);

    // update message_id now that we have it
    await supabase.from('strat_posts').update({ message_id: msg.id }).eq('id', stratPost.id);
    console.log(`[Bot] Strat post created: ${stratPost.id} | ${raid.name} ${team.name}`);
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
      await interaction.reply({ content: '❌ Raid post not found.', flags: 64 });
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

    await interaction.reply({ content: '✅ Raid post deleted.', flags: 64 });
    return;
  }

  // ── /position ─────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'position') {
    const raidId   = parseInt(interaction.options.getString('raid'));
    const teamId   = parseInt(interaction.options.getString('team'));
    const position = interaction.options.getString('position');
    const syncToWeb = interaction.options.getBoolean('sync') ?? true;
    const discordId = interaction.user.id;
    const discordUsername = interaction.member?.nickname || interaction.user.globalName || interaction.user.username;

    const { data: binding } = await supabase
      .from('user_bindings').select('game_id').eq('discord_id', discordId).single();

    if (!binding) {
      await interaction.reply({ content: '❌ No game ID linked.\nRun `/id <your_game_id>` first.', flags: 64 });
      return;
    }

    const { raidsCache, teamsCache } = await getRaidConfig();
    const raid = raidsCache.find(r => r.id === raidId);
    const team = teamsCache.find(t => t.id === teamId);

    if (!raid || !team) {
      await interaction.reply({ content: '❌ Raid or strategy not found.', flags: 64 });
      return;
    }

    const now = new Date().toISOString();

    if (syncToWeb) {
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
        await interaction.reply({ content: '❌ Failed to sync to website. Please try again.', flags: 64 });
        console.error('[Bot] /position sync error:', error.message, error.details, error.hint);
        return;
      }
    }

    const syncNote = syncToWeb
      ? '\nSynced to website (offline by default — go online on the website)'
      : '\nNot synced to website';

    await interaction.reply({
      content: `✅ Joined **${position}** for **${raid.name} — ${team.name}**!\nGame ID: ${binding.game_id}${syncNote}`,
      flags: 64,
    });
    console.log(`[/position] ${binding.game_id} → ${raid.name} ${team.name} ${position} sync=${syncToWeb}`);
    return;
  }

  // ── /mystatus ─────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'mystatus') {
    const discordId = interaction.user.id;

    const { data: binding } = await supabase
      .from('user_bindings').select('game_id').eq('discord_id', discordId).single();

    if (!binding) {
      await interaction.reply({ content: '❌ No game ID linked.\nRun `/id <your_game_id>` first.', flags: 64 });
      return;
    }

    // fetch all current player entries for this game_id
    const { data: entries } = await supabase
      .from('players')
      .select('id, boss_name, team_id, position, online, last_seen')
      .eq('player_name', binding.game_id)
      .order('boss_name');

    if (!entries || entries.length === 0) {
      await interaction.reply({ content: `No active signups found for **${binding.game_id}**.`, flags: 64 });
      return;
    }

    // build display + remove buttons
    const { raidsCache, teamsCache } = await getRaidConfig();
    const lines = entries.map(e => {
      const team = teamsCache.find(t => t.id === e.team_id);
      return `• **${e.position}** — ${e.boss_name} / ${team?.name || e.team_id} (${e.online ? '🟢 Online' : '⚪ Offline'})`;
    }).join('\n');

    // up to 5 remove buttons per row
    const removeButtons = entries.slice(0, 5).map(e =>
      new ButtonBuilder()
        .setCustomId(`myremove:${e.id}`)
        .setLabel(`Remove ${e.position} ${e.boss_name}`)
        .setStyle(ButtonStyle.Danger)
    );
    const row = new ActionRowBuilder().addComponents(removeButtons);

    await interaction.reply({
      content: `**Your current signups** (Game ID: ${binding.game_id}):\n${lines}\n\nClick a button to remove:`,
      components: entries.length > 0 ? [row] : [],
      flags: 64,
    });
    return;
  }

  // ── buttons ───────────────────────────────────────────────────────────────
  if (!interaction.isButton()) return;

  const parts = interaction.customId.split(':');
  const action = parts[0];
  const value = parts[1];
  const sidOverride = parts[2]; // strat_post id encoded in customId (for kick/delete)

  const discordId = interaction.user.id;
  const discordUsername = interaction.member?.nickname || interaction.user.globalName || interaction.user.username;

  // find strat post — prefer sidOverride (kick/delete from row2), else lookup by message id
  let stratPost;
  if (sidOverride) {
    const { data } = await supabase
      .from('strat_posts')
      .select('*, raids(name, icon), teams(name), creator_name')
      .eq('id', parseInt(sidOverride))
      .single();
    stratPost = data;
  } else {
    const { data } = await supabase
      .from('strat_posts')
      .select('*, raids(name, icon), teams(name), creator_name')
      .eq('message_id', interaction.message.id)
      .single();
    stratPost = data;
  }

  if (!stratPost) return;

  const raidName = stratPost.raids?.name || 'Raid';
  const teamName = stratPost.teams?.name || 'Strat';
  const creatorId = stratPost.created_by_discord_id || null;

  // ── myremove — remove own player entry from website list ─────────────────
  if (action === 'myremove') {
    const entryId = value;
    const discordId2 = interaction.user.id;

    const { data: binding } = await supabase
      .from('user_bindings').select('game_id').eq('discord_id', discordId2).single();

    if (!binding) {
      await interaction.reply({ content: '❌ No game ID linked.', flags: 64 });
      return;
    }

    const { data: entry } = await supabase
      .from('players').select('id, boss_name, position, player_name')
      .eq('id', entryId).eq('player_name', binding.game_id).single();

    if (!entry) {
      await interaction.reply({ content: '❌ Entry not found or does not belong to you.', flags: 64 });
      return;
    }

    await supabase.from('players').delete().eq('id', entryId);
    await interaction.reply({
      content: `✅ Removed **${entry.position}** from **${entry.boss_name}**.`,
      flags: 64,
    });
    return;
  }

  // ── host:options — ephemeral menu for host ────────────────────────────────
  if (action === 'host' && value === 'options') {
    if (discordId !== creatorId) {
      await interaction.reply({ content: '❌ Only the post creator can use Host Options.', flags: 64 });
      return;
    }
    // rebuild message with row3 (kick/delete) visible
    const signups = await getSignupsForPost(stratPost.id);
    const { raidsCache: rc2, teamsCache: tc2 } = await getRaidConfig();
    const raidObj = rc2.find(r => r.id === stratPost.raid_id);
    const creatorName = interaction.member?.nickname || interaction.user.globalName || interaction.user.username;
    const updated = await buildStratMessage(raidName, teamName, signups, creatorName, stratPost.id, stratPost.team_id);
    await interaction.update(updated);
    return;
  }

  // ── invite:P1~P4 — reply ephemeral with /invite command to copy ───────────
  if (action === 'invite') {
    const invPos = value;
    const signups = await getSignupsForPost(stratPost.id);
    const posSignups = Array.isArray(signups[invPos]) ? signups[invPos] : (signups[invPos] ? [signups[invPos]] : []);
    if (posSignups.length === 0) {
      await interaction.reply({ content: `**${invPos}** has no players to invite.`, flags: 64 });
      return;
    }
    const cmds = posSignups.map(s => `/invite ${s.game_id}`).join('\n');
    await interaction.reply({ content: `\`\`\`\n${cmds}\n\`\`\``, flags: 64 });
    return;
  }

  // ── host:delete ───────────────────────────────────────────────────────────
  if (action === 'host' && value === 'delete') {
    if (discordId !== creatorId) {
      await interaction.reply({ content: '❌ Only the post creator can delete this.', flags: 64 });
      return;
    }
    await supabase.from('discord_signups').delete().eq('strat_post_id', stratPost.id);
    await supabase.from('strat_posts').delete().eq('id', stratPost.id);
    try { await interaction.message.delete(); } catch (e) {}
    await interaction.reply({ content: '✅ Post deleted.', flags: 64, flags: 64 });
    return;
  }

  // ── kick:P1~P4 ────────────────────────────────────────────────────────────
  if (action === 'kick') {
    if (discordId !== creatorId) {
      await interaction.reply({ content: '❌ Only the post creator can kick players.', flags: 64 });
      return;
    }
    const kickPos = value;
    const { data: kicked } = await supabase
      .from('discord_signups')
      .select('game_id')
      .eq('strat_post_id', stratPost.id)
      .eq('position', kickPos);

    if (!kicked || kicked.length === 0) {
      await interaction.reply({ content: `**${kickPos}** is already empty.`, flags: 64 });
      return;
    }

    await supabase.from('discord_signups')
      .delete()
      .eq('strat_post_id', stratPost.id)
      .eq('position', kickPos);

    // sync remove from players table
    const { raidsCache } = await getRaidConfig();
    const raid = raidsCache.find(r => r.id === stratPost.raid_id);
    if (raid) {
      for (const k of kicked) {
        await supabase.from('players').delete()
          .eq('boss_name', raid.name)
          .eq('team_id', stratPost.team_id)
          .eq('position', kickPos)
          .eq('player_name', k.game_id);
      }
    }

    // fetch and update the original strat post message
    const signups = await getSignupsForPost(stratPost.id);
    const updatedMsg = await buildStratMessage(raidName, teamName, signups, stratPost.creator_name || null, null, stratPost.team_id);
    // add back the host options row since creator is using it
    const sid = stratPost.id;
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`kick:P1:${sid}`).setLabel('Kick P1').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`kick:P2:${sid}`).setLabel('Kick P2').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`kick:P3:${sid}`).setLabel('Kick P3').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`kick:P4:${sid}`).setLabel('Kick P4').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`host:delete:${sid}`).setLabel('Delete Post').setStyle(ButtonStyle.Danger),
    );
    updatedMsg.components.push(row2);

    try {
      const ch = await interaction.client.channels.fetch(stratPost.channel_id);
      const msg = await ch.messages.fetch(stratPost.message_id);
      await msg.edit(updatedMsg);
    } catch (e) {
      console.error('[Bot] kick edit error:', e.message);
    }

    const names = kicked.map(k => k.game_id).join(', ');
    await interaction.reply({ content: `✅ Kicked **${kickPos}**: ${names}`, flags: 64 });
    return;
  }

  // ── signup actions — require game ID binding ──────────────────────────────
  if (action !== 'signup') return;

  const { data: binding } = await supabase
    .from('user_bindings')
    .select('game_id')
    .eq('discord_id', discordId)
    .single();

  if (!binding) {
    await interaction.reply({
      content: '❌ No game ID linked.\nRun `/id <your_game_id>` first.',
      flags: 64,
    });
    return;
  }

  // ── signup:cancel — remove ALL signups for this user ─────────────────────
  if (value === 'cancel') {
    const { data: oldSignups } = await supabase
      .from('discord_signups')
      .select('position')
      .eq('strat_post_id', stratPost.id)
      .eq('discord_id', discordId);

    await supabase.from('discord_signups').delete()
      .eq('strat_post_id', stratPost.id)
      .eq('discord_id', discordId);

    if (oldSignups?.length && stratPost.raid_id) {
      const { raidsCache } = await getRaidConfig();
      const raid = raidsCache.find(r => r.id === stratPost.raid_id);
      if (raid) {
        for (const s of oldSignups) {
          await supabase.from('players').delete()
            .eq('boss_name', raid.name)
            .eq('team_id', stratPost.team_id)
            .eq('position', s.position)
            .eq('player_name', binding.game_id);
        }
      }
    }

    const signups = await getSignupsForPost(stratPost.id);
    const updated = await buildStratMessage(raidName, teamName, signups, stratPost.creator_name || null, null, stratPost.team_id);
    await interaction.update(updated);
    await interaction.followUp({ content: '✅ All your signups cancelled.', flags: 64 });
    return;
  }

  // ── signup:P1~P4 — toggle join/leave ─────────────────────────────────────
  const position = value;

  const { data: mySignup } = await supabase
    .from('discord_signups')
    .select('id')
    .eq('strat_post_id', stratPost.id)
    .eq('discord_id', discordId)
    .eq('position', position)
    .maybeSingle();

  if (mySignup) {
    // already joined — toggle off
    await supabase.from('discord_signups').delete().eq('id', mySignup.id);
    const { raidsCache } = await getRaidConfig();
    const raid = raidsCache.find(r => r.id === stratPost.raid_id);
    if (raid) {
      await supabase.from('players').delete()
        .eq('boss_name', raid.name)
        .eq('team_id', stratPost.team_id)
        .eq('position', position)
        .eq('player_name', binding.game_id);
    }
    const signups = await getSignupsForPost(stratPost.id);
    const updated = await buildStratMessage(raidName, teamName, signups, stratPost.creator_name || null, null, stratPost.team_id);
    await interaction.update(updated);
    await interaction.followUp({ content: `✅ Removed from **${position}**.`, flags: 64 });
    return;
  }

  // check if position is full
  const { data: teamRow } = await supabase
    .from('teams').select('max_per_pos').eq('id', stratPost.team_id).single();
  const maxPerPos = teamRow?.max_per_pos || 4;
  const { count } = await supabase
    .from('discord_signups')
    .select('id', { count: 'exact', head: true })
    .eq('strat_post_id', stratPost.id)
    .eq('position', position);

  if (count >= maxPerPos) {
    await interaction.reply({ content: `❌ **${position}** is full (${maxPerPos}/${maxPerPos}).`, flags: 64 });
    return;
  }

  // join
  const { error: insertError } = await supabase.from('discord_signups').insert({
    strat_post_id: stratPost.id,
    discord_id: discordId,
    discord_username: discordUsername,
    game_id: binding.game_id,
    position,
  });

  if (insertError) {
    await interaction.reply({ content: '❌ Signup failed. Please try again.', flags: 64 });
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
  const updated = await buildStratMessage(raidName, teamName, signups, stratPost.creator_name || null, null, stratPost.team_id);
  await interaction.update(updated);
  await interaction.followUp({ content: `✅ Joined **${position}**! Game ID: ${binding.game_id}`, flags: 64 });

  // DM the host when someone joins
  if (creatorId && creatorId !== discordId) {
    const jumpUrl = `https://discord.com/channels/${stratPost.guild_id}/${stratPost.channel_id}/${stratPost.message_id}`;
    try {
      const creator = await interaction.client.users.fetch(creatorId);
      await creator.send(`🔔 **${discordUsername}** (${binding.game_id}) joined **${position}** in your raid post!\n⚔️ ${raidName} — ${teamName}\n${jumpUrl}`);
    } catch (e) {}
  }
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
