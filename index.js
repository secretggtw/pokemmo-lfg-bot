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
  P1: '🟦',
  P2: '🟩',
  P3: '🟨',
  P4: '🟥',
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
async function buildStratMessage(raidName, teamName, signups = {}) {
  // signups = { P1: { game_id, discord_username } | null, P2: ..., ... }
  const embed = new EmbedBuilder()
    .setTitle(`📋 ${raidName} — ${teamName}`)
    .setColor(0x5865f2)
    .setDescription(
      POSITIONS.map(pos => {
        const s = signups[pos];
        const icon = POSITION_EMOJI[pos];
        return s
          ? `${icon} **${pos}** ｜ ${s.game_id} ✅`
          : `${icon} **${pos}** ｜ 空位`;
      }).join('\n')
    )
    .setFooter({ text: '點擊按鈕報名 · 再次點擊取消 · 需先執行 /id 綁定遊戲帳號' })
    .setTimestamp();

  // 第一排：P1 P2 P3 P4
  const row1 = new ActionRowBuilder().addComponents(
    POSITIONS.map(pos => {
      const s = signups[pos];
      return new ButtonBuilder()
        .setCustomId(`signup:${pos}`)
        .setLabel(s ? `${pos} ✅` : `報名 ${pos}`)
        .setStyle(s ? ButtonStyle.Success : ButtonStyle.Primary)
        .setDisabled(!!s && false); // 即使有人也可按（用來取消）
    })
  );

  // 第二排：取消報名
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('signup:cancel')
      .setLabel('取消報名')
      .setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row1, row2] };
}

// 從 DB 讀取當前 strat_post 的報名狀態
async function getSignupsForPost(stratPostId) {
  const { data } = await supabase
    .from('discord_signups')
    .select('position, game_id, discord_username')
    .eq('strat_post_id', stratPostId);

  const signups = {};
  for (const row of data || []) {
    signups[row.position] = { game_id: row.game_id, discord_username: row.discord_username };
  }
  return signups;
}

// ─── slash command registration ─────────────────────────────────────────────
async function registerCommands() {
  const commands = [
    // /id — 綁定遊戲 ID
    new SlashCommandBuilder()
      .setName('id')
      .setDescription('綁定或查看你的 PokéMMO 遊戲 ID')
      .addStringOption(opt =>
        opt.setName('game_id')
          .setDescription('你的 PokéMMO 遊戲 ID（不填則查看目前綁定）')
          .setRequired(false)
      ),

    // /strat — 發布 strat 招募貼文
    new SlashCommandBuilder()
      .setName('strat')
      .setDescription('發布 Raid Strat 招募貼文')
      .addStringOption(opt =>
        opt.setName('raid')
          .setDescription('選擇 Raid Boss')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption(opt =>
        opt.setName('team')
          .setDescription('選擇 Strat 隊伍配置')
          .setRequired(true)
          .setAutocomplete(true)
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
client.once('ready', async () => {
  console.log(`[Bot] Ready: ${client.user.tag}`);
  await registerCommands();
  setInterval(markStale, 10 * 60 * 1000);
});

// ─── event: autocomplete ────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isAutocomplete()) return;

  const { raidsCache, teamsCache } = await getRaidConfig();

  if (interaction.commandName === 'strat') {
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
          content: '❌ 尚未綁定遊戲 ID\n請執行 `/id <遊戲ID>` 來綁定',
          ephemeral: true,
        });
      } else {
        await interaction.reply({
          content: `✅ 目前綁定的遊戲 ID：**${data.game_id}**\n如需更改請執行 \`/id <新ID>\``,
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
      await interaction.reply({ content: '❌ 綁定失敗，請稍後再試', ephemeral: true });
    } else {
      await interaction.reply({
        content: `✅ 綁定成功！遊戲 ID：**${gameId}**\n之後點擊 Strat 貼文按鈕即可直接報名`,
        ephemeral: true,
      });
    }
    return;
  }

  // ── /strat ────────────────────────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'strat') {
    const raidId = parseInt(interaction.options.getString('raid'));
    const teamId = parseInt(interaction.options.getString('team'));

    const { raidsCache, teamsCache } = await getRaidConfig();
    const raid = raidsCache.find(r => r.id === raidId);
    const team = teamsCache.find(t => t.id === teamId);

    if (!raid || !team) {
      await interaction.reply({ content: '❌ 找不到對應的 Raid 或 Strat', ephemeral: true });
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

  // ── buttons ───────────────────────────────────────────────────────────────
  if (!interaction.isButton()) return;

  const [action, value] = interaction.customId.split(':');
  if (action !== 'signup') return;

  const discordId = interaction.user.id;
  const discordUsername = interaction.member?.nickname || interaction.user.globalName || interaction.user.username;

  // 查這則訊息是不是我們的 strat_post
  const { data: stratPost } = await supabase
    .from('strat_posts')
    .select('*, raids(name, icon), teams(name)')
    .eq('message_id', interaction.message.id)
    .single();

  if (!stratPost) return; // 不是我們的訊息，忽略

  // 查玩家綁定
  const { data: binding } = await supabase
    .from('user_bindings')
    .select('game_id')
    .eq('discord_id', discordId)
    .single();

  if (!binding) {
    await interaction.reply({
      content: '❌ 尚未綁定遊戲 ID\n請先執行 `/id <遊戲ID>` 完成綁定',
      ephemeral: true,
    });
    return;
  }

  // ── 取消報名 ──────────────────────────────────────────────────────────────
  if (value === 'cancel') {
    const { error } = await supabase
      .from('discord_signups')
      .delete()
      .eq('strat_post_id', stratPost.id)
      .eq('discord_id', discordId);

    if (error) {
      await interaction.reply({ content: '❌ 取消失敗，請稍後再試', ephemeral: true });
      return;
    }

    // 重新 render embed
    const signups = await getSignupsForPost(stratPost.id);
    const raidName = stratPost.raids?.name || 'Raid';
    const teamName = stratPost.teams?.name || 'Strat';
    const updated = await buildStratMessage(raidName, teamName, signups);
    await interaction.update(updated);
    await interaction.followUp({ content: '✅ 已取消報名', ephemeral: true });
    return;
  }

  // ── 報名 / 換位置 ─────────────────────────────────────────────────────────
  const position = value; // 'P1' ~ 'P4'

  // 確認位置是否已有人（排除自己）
  const { data: existing } = await supabase
    .from('discord_signups')
    .select('discord_id, discord_username')
    .eq('strat_post_id', stratPost.id)
    .eq('position', position)
    .neq('discord_id', discordId)
    .maybeSingle();

  if (existing) {
    await interaction.reply({
      content: `❌ ${position} 已被 **${existing.discord_username}** 佔用`,
      ephemeral: true,
    });
    return;
  }

  // 先刪掉這個人在此 strat 的舊報名（換位置）
  await supabase
    .from('discord_signups')
    .delete()
    .eq('strat_post_id', stratPost.id)
    .eq('discord_id', discordId);

  // 插入新報名
  const { error: insertError } = await supabase.from('discord_signups').insert({
    strat_post_id: stratPost.id,
    discord_id: discordId,
    discord_username: discordUsername,
    game_id: binding.game_id,
    position,
  });

  if (insertError) {
    await interaction.reply({ content: '❌ 報名失敗，請稍後再試', ephemeral: true });
    return;
  }

  // 重新 render embed
  const signups = await getSignupsForPost(stratPost.id);
  const raidName = stratPost.raids?.name || 'Raid';
  const teamName = stratPost.teams?.name || 'Strat';
  const updated = await buildStratMessage(raidName, teamName, signups);
  await interaction.update(updated);
  await interaction.followUp({
    content: `✅ 已報名 **${position}**，遊戲 ID：${binding.game_id}`,
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
client.login(process.env.DISCORD_TOKEN);
