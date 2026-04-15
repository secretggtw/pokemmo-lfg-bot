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
  Partials,
} = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// ─── clients ───────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message],
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
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

function isUnknownMessageError(error) {
  return error?.code === 10008 || /Unknown Message/i.test(error?.message || '');
}

const RAID_POST_EXPIRE_MS = 2 * 60 * 60 * 1000;
const expiredStratPostIds = new Set();

function isRaidPostExpired(createdAt) {
  if (!createdAt) return false;
  return Date.now() - new Date(createdAt).getTime() >= RAID_POST_EXPIRE_MS;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
const pendingRealtimeRefreshes = new Map();

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
// boss emoji map (server custom emojis)
const BOSS_EMOJI = {
  heatran:  '<:heatran:1491989556696846427>',
  cresselia:'<:cresselia:1491989507522822255>',
  meloetta: '<:meloetta:1491989203909611530>',
  cobalion: '<:cobalion:1491989450287218708>',
  terrakion:'<:terrakion:1491989270137798686>',
  virizion: '<:virizon:1491989398433304636>',
};

function getBossEmoji(raidName) {
  const key = raidName.toLowerCase();
  return BOSS_EMOJI[key] || '';
}

function buildQuickRaidMessage(raidName, teamName, creatorName = null) {
  const hostLine = creatorName ? `👑 Host: **${creatorName}**\n` : '';
  const bossEmoji = getBossEmoji(raidName);
  const posLines = POSITIONS.map(pos => `**${pos}** | Open`).join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`${bossEmoji} ${raidName}`)
    .setColor(0x5865f2)
    .setDescription(`### ⚔️ ${teamName}\n` + hostLine + posLines)
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    ...POSITIONS.map(pos =>
      new ButtonBuilder()
        .setCustomId(`signup:${pos}`)
        .setLabel(`Join ${pos}`)
        .setStyle(ButtonStyle.Primary)
    ),
    new ButtonBuilder()
      .setCustomId('signup:cancel')
      .setLabel('Clear')
      .setStyle(ButtonStyle.Danger)
  );

  return { embeds: [embed], components: [row1] };
}

// 從 DB 讀取當前 /raid post 的報名狀態（每個 position 最多一人；資料以 array 形式回傳供 embed 組裝）
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

async function setAllPlayerEntriesOnlineState(gameId, setOnline) {
  const updates = setOnline
    ? {
        online: true,
        last_seen: new Date().toISOString(),
        online_until: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }
    : {
        online: false,
        online_until: null,
      };

  const { data, error } = await supabase
    .from('players')
    .update(updates)
    .eq('player_name', gameId)
    .select('team_id');

  if (error) throw error;
  return [...new Set((data || []).map(row => row.team_id).filter(Boolean))];
}

// ─── build /myposition ephemeral message ────────────────────────────────────
async function buildMyPositionMessage(gameId, page = 0) {
  const { data: entries } = await supabase
    .from('players')
    .select('id, boss_name, team_id, position, online, last_seen')
    .eq('player_name', gameId)
    .order('boss_name');

  if (!entries || entries.length === 0) {
    return { content: `No active signups found for **${gameId}**.`, components: [] };
  }

  const { teamsCache } = await getRaidConfig();
  const PAGE_SIZE = 5;
  const totalPages = Math.ceil(entries.length / PAGE_SIZE);
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const pageEntries = entries.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const lines = entries.map((e, i) => {
    const team = teamsCache.find(t => t.id === e.team_id);
    const marker = e.online ? '🟢' : '⚪';
    return `${marker} **${e.position}** — ${e.boss_name} / ${team?.name || e.team_id}`;
  }).join('\n');

  // row1: toggle (current page, up to 5)
  const toggleRow = new ActionRowBuilder().addComponents(
    pageEntries.map(e => {
      const team = teamsCache.find(t => t.id === e.team_id);
      const stratLabel = (team?.name || String(e.team_id)).slice(0, 12);
      return new ButtonBuilder()
        .setCustomId(`mytoggle:${e.id}:${safePage}`)
        .setLabel(`${e.online ? '🟢' : '⚪'} ${e.position} ${stratLabel}`)
        .setStyle(e.online ? ButtonStyle.Success : ButtonStyle.Secondary);
    })
  );

  // row2: remove (current page, up to 5)
  const removeRow = new ActionRowBuilder().addComponents(
    pageEntries.map(e => {
      const team = teamsCache.find(t => t.id === e.team_id);
      const stratLabel = (team?.name || String(e.team_id)).slice(0, 10);
      return new ButtonBuilder()
        .setCustomId(`myremove:${e.id}:${safePage}`)
        .setLabel(`Remove ${e.position} ${stratLabel}`)
        .setStyle(ButtonStyle.Danger);
    })
  );

  const rows = [toggleRow, removeRow];

  // row3: pagination (only if more than 1 page)
  if (totalPages > 1) {
    const pageRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`mypage:prev:${safePage}:${gameId}`)
        .setLabel('◀ Prev')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage === 0),
      new ButtonBuilder()
        .setCustomId(`mypage:next:${safePage}:${gameId}`)
        .setLabel('▶ Next')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage === totalPages - 1),
    );
    rows.push(pageRow);
  }

  const pageInfo = totalPages > 1 ? ` (${safePage + 1}/${totalPages})` : '';
  return {
    content: `**Your positions** (Game ID: ${gameId})${pageInfo}:\n${lines}\n\nToggle online/offline or remove:`,
    components: rows,
  };
}

// ─── build strat board embed + buttons ──────────────────────────────────────
async function buildStratBoard(raidName, teamName, teamId, raidNameForUrl) {
  const baseUrl = 'https://pokemmo-raid-team-finder.vercel.app';
  const playerListUrl = `${baseUrl}/?boss=${encodeURIComponent(raidNameForUrl)}&team=${teamId}`;
  const bossEmoji = getBossEmoji(raidName);

  // fetch guide URL
  let guideUrl = null;
  const { data: teamData } = await supabase
    .from('teams').select('guide_url').eq('id', teamId).single();
  guideUrl = teamData?.guide_url || null;

  // fetch player counts per position
  const { data: players } = await supabase
    .from('players')
    .select('position, online')
    .eq('boss_name', raidName)
    .eq('team_id', teamId);

  const counts = {};
  for (const pos of POSITIONS) {
    const posPlayers = (players || []).filter(p => p.position === pos);
    counts[pos] = { total: posPlayers.length, online: posPlayers.filter(p => p.online).length };
  }

  const posLines = POSITIONS.map(pos => {
    const { total, online } = counts[pos];
    const onlineStr = online > 0 ? `🟢 ${online} online` : `⚪ 0 online`;
    return `**${pos}** | ${onlineStr} / ${total} total`;
  }).join('\n');

  const pokemonUrl = `${baseUrl}/?strat=${teamId}&tab=All`;

  const linkParts2 = [];
  if (guideUrl) linkParts2.push(`[Guide](${guideUrl})`);
  linkParts2.push(`[Pokemon](${pokemonUrl})`);
  linkParts2.push(`[Player List](${playerListUrl})`);

  const infoLine = '\n-# Join to add yourself to the player list · Online (30 min) shows you as available on the website';

  const embed = new EmbedBuilder()
    .setTitle(`${bossEmoji} ${raidName}`)
    .setColor(0x5865f2)
    .setDescription(`### ⚔️ ${teamName}\n` + posLines + '\n' + linkParts2.join(' · ') + infoLine)
    .setTimestamp();

  // row1: Join P1 Join P2 Join P3 Join P4 + Leave
  const row1 = new ActionRowBuilder().addComponents(
    ...POSITIONS.map(pos =>
      new ButtonBuilder()
        .setCustomId(`board:${pos}:${teamId}`)
        .setLabel(`Join ${pos}`)
        .setStyle(ButtonStyle.Primary)
    ),
    new ButtonBuilder()
      .setCustomId(`board:leave:${teamId}`)
      .setLabel('Clear')
      .setStyle(ButtonStyle.Danger)
  );

  // row2: Online 30min | Offline
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`boardonline:on:${teamId}`)
      .setLabel('Online (30 min)')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`boardonline:off:${teamId}`)
      .setLabel('Offline')
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row1, row2] };
}

// refresh all strat boards for a given team after a player joins/leaves
async function refreshStratBoards(teamId) {
  const { data: boards } = await supabase
    .from('strat_boards')
    .select('*, raids(name), teams(name)')
    .eq('team_id', teamId);

  if (!boards || boards.length === 0) return;

  for (const board of boards) {
    try {
      const raidName = board.raids?.name || '';
      const teamName = board.teams?.name || '';
      const msg = await buildStratBoard(raidName, teamName, teamId, raidName);
      const ch = await client.channels.fetch(board.channel_id);
      const discordMsg = await ch.messages.fetch(board.message_id);
      await discordMsg.edit(msg);
    } catch (e) {
      if (isUnknownMessageError(e)) {
        console.warn(`[Bot] refreshStratBoards removing stale board: board_id=${board.id} message_id=${board.message_id}`);
        const { error: deleteError } = await supabase
          .from('strat_boards')
          .delete()
          .eq('id', board.id);

        if (deleteError) {
          console.error(`[Bot] refreshStratBoards cleanup error: board_id=${board.id}`, deleteError.message);
        }
        continue;
      }

      console.error(`[Bot] refreshStratBoards error: board_id=${board.id} message_id=${board.message_id}`, e.message);
    }
  }
}

function isDiscordSnowflake(value) {
  return /^\d+$/.test(String(value || ''));
}

async function updateStratPostEmbeds(stratPost, msgPayload) {
  const tasks = [];

  if (isDiscordSnowflake(stratPost.channel_id) && isDiscordSnowflake(stratPost.message_id)) {
    tasks.push((async () => {
      try {
        const ch = await client.channels.fetch(stratPost.channel_id);
        const msg = await ch.messages.fetch(stratPost.message_id);
        await msg.edit(msgPayload);
      } catch (e) {
        console.error('[Bot] updateStratPostEmbeds (original) error:', e.message);
      }
    })());
  }

  if (
    stratPost.thread_message_id &&
    stratPost.thread_channel_id &&
    isDiscordSnowflake(stratPost.thread_message_id) &&
    isDiscordSnowflake(stratPost.thread_channel_id)
  ) {
    tasks.push((async () => {
      try {
        const threadCh = await client.channels.fetch(stratPost.thread_channel_id);
        const threadMsg = await threadCh.messages.fetch(stratPost.thread_message_id);
        await threadMsg.edit(msgPayload);
      } catch (e) {
        console.error('[Bot] updateStratPostEmbeds (thread) error:', e.message);
      }
    })());
  }

  await Promise.all(tasks);
}

async function refreshStratPostsForTeam(teamId) {
  const { data: posts } = await supabase
    .from('strat_posts')
    .select('*, raids(name), teams(name)')
    .eq('team_id', teamId);

  if (!posts || posts.length === 0) return;

  for (const stratPost of posts) {
    try {
      if (!isDiscordSnowflake(stratPost.channel_id) || !isDiscordSnowflake(stratPost.message_id)) {
        continue;
      }

      const raidName = stratPost.raids?.name || 'Raid';
      const teamName = stratPost.teams?.name || 'Strat';
      const signups = await getSignupsForPost(stratPost.id);
      const payload = await buildStratMessage(
        raidName,
        teamName,
        signups,
        stratPost.creator_name || null,
        stratPost.id,
        stratPost.team_id,
        { createdAt: stratPost.created_at }
      );
      await updateStratPostEmbeds(stratPost, payload);
    } catch (e) {
      console.error(`[Bot] refreshStratPostsForTeam error: team_id=${teamId} strat_post_id=${stratPost.id}`, e.message);
    }
  }
}

function queueRealtimeRefresh(teamId) {
  if (!teamId) return;

  const existing = pendingRealtimeRefreshes.get(teamId);
  if (existing) clearTimeout(existing);

  const timeout = setTimeout(async () => {
    pendingRealtimeRefreshes.delete(teamId);
    try {
      await refreshStratBoards(teamId);
      await refreshStratPostsForTeam(teamId);
    } catch (e) {
      console.error(`[Bot] realtime refresh error: team_id=${teamId}`, e.message);
    }
  }, 1000);

  pendingRealtimeRefreshes.set(teamId, timeout);
}

async function sendHostRaidNotification(stratPost, content, actorGameId = null) {
  const creatorId = stratPost?.created_by_discord_id;
  const creatorName = stratPost?.creator_name;
  if (!creatorId) return;
  if (!isDiscordSnowflake(creatorId)) return;
  if (actorGameId && creatorName && actorGameId === creatorName) return;

  try {
    const creator = await client.users.fetch(creatorId);
    const jumpUrl = `https://discord.com/channels/${stratPost.guild_id}/${stratPost.channel_id}/${stratPost.message_id}`;
    await creator.send(`${content}\n${jumpUrl}`);
  } catch (e) {
    console.error(`[Bot] sendHostRaidNotification error: strat_post_id=${stratPost.id}`, e.message);
  }
}

async function notifyHostOfWebsiteRoomEvent(eventRow) {
  if (!eventRow?.strat_post_id || !eventRow?.player_name) {
    console.log('[Bot] notifyHostOfWebsiteRoomEvent skipped: missing strat_post_id or player_name');
    return;
  }
  if (!['join', 'leave'].includes(eventRow.action)) {
    console.log(`[Bot] notifyHostOfWebsiteRoomEvent skipped: unsupported action=${eventRow?.action}`);
    return;
  }

  const { data: stratPost } = await supabase
    .from('strat_posts')
    .select('id, message_id, channel_id, guild_id, created_by_discord_id, creator_name, raids(name), teams(name)')
    .eq('id', eventRow.strat_post_id)
    .maybeSingle();

  if (!stratPost?.created_by_discord_id) {
    console.log(`[Bot] notifyHostOfWebsiteRoomEvent skipped: no matching strat post for strat_post_id=${eventRow.strat_post_id}`);
    return;
  }

  console.log(`[Bot] notifyHostOfWebsiteRoomEvent matched strat_post_id=${eventRow.strat_post_id} action=${eventRow.action}`);

  const actionText = eventRow.action === 'leave' ? 'left' : 'joined';

  try {
    await sendHostRaidNotification(
      stratPost,
      `🔔 **${eventRow.player_name}** ${actionText} **${eventRow.position || 'a slot'}** from the website.\n⚔️ ${stratPost.raids?.name || eventRow.boss_name || 'Raid'} — ${stratPost.teams?.name || 'Strat'}`,
      eventRow.player_name
    );
  } catch (e) {
    console.error(`[Bot] notifyHostOfWebsiteRoomEvent error: strat_post_id=${eventRow.strat_post_id}`, e.message);
  }
}

async function syncRaidPostToWebsite({
  messageId,
  channelId,
  guildId,
  discordUsername,
  ign,
  bossName,
  teamId,
  postedAt,
}) {
  const guild = client.guilds.cache.get(guildId);
  const channel = guild?.channels?.cache.get(channelId);
  const jumpUrl = `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;

  const { error } = await supabase.from('lfg_posts').upsert({
    discord_msg_id: messageId,
    discord_server_id: guildId,
    discord_channel_id: channelId,
    discord_username: discordUsername,
    ign,
    boss_name: bossName,
    strat_name: String(teamId),
    positions: [],
    raw_message: `/raid ${bossName} ${teamId}`,
    posted_at: postedAt || new Date().toISOString(),
    is_stale: false,
    discord_jump_url: jumpUrl,
    server_name: guild?.name || guildId,
    channel_name: channel?.name || channelId,
  }, { onConflict: 'discord_msg_id' });

  if (error) {
    console.error('[Bot] syncRaidPostToWebsite error:', error.message);
    return false;
  }

  return true;
}

async function deleteWebsitePost(messageId) {
  if (!messageId) return;

  const { error } = await supabase
    .from('lfg_posts')
    .delete()
    .eq('discord_msg_id', messageId);

  if (error) {
    console.error(`[Bot] deleteWebsitePost error: message_id=${messageId}`, error.message);
  }
}

// ─── slash command registration ─────────────────────────────────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('id')
      .setDescription('Link or view your PokeMMO game ID')
      .addStringOption(opt =>
        opt.setName('game_id')
          .setDescription('Your PokeMMO in-game name (leave blank to view current)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('raid')
      .setDescription('Host a raid')
      .addStringOption(opt =>
        opt.setName('raid')
          .setDescription('Select a raid boss')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption(opt =>
        opt.setName('strat')
          .setDescription('Select a strat')
          .setRequired(true)
          .setAutocomplete(true)
      ),

    new SlashCommandBuilder()
      .setName('delete')
      .setDescription('Delete a raid post you created')
      .addStringOption(opt =>
        opt.setName('message_id')
          .setDescription('Message ID of the raid post (right-click → Copy Message ID)')
          .setRequired(true)
      ),

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
        opt.setName('strat')
          .setDescription('Select a strat')
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

    new SlashCommandBuilder()
      .setName('myposition')
      .setDescription('View and manage your current raid positions'),

    new SlashCommandBuilder()
      .setName('online')
      .setDescription('Set all your joined positions to online for 30 minutes'),

    new SlashCommandBuilder()
      .setName('offline')
      .setDescription('Set all your joined positions to offline'),

    new SlashCommandBuilder()
      .setName('strat')
      .setDescription('Create a permanent strat board with player count stats')
      .addStringOption(opt =>
        opt.setName('raid')
          .setDescription('Select a raid boss')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption(opt =>
        opt.setName('strat')
          .setDescription('Select a strat')
          .setRequired(true)
          .setAutocomplete(true)
      ),
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  try {
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

async function expireRaidPostButtons() {
  const twoHoursAgo = new Date(Date.now() - RAID_POST_EXPIRE_MS).toISOString();
  const { data: expiredPosts } = await supabase
    .from('strat_posts')
    .select('id, created_at, channel_id, message_id, thread_channel_id, thread_message_id, raids(name), teams(name), creator_name, team_id')
    .lt('created_at', twoHoursAgo);

  if (!expiredPosts || expiredPosts.length === 0) return;

  for (const stratPost of expiredPosts) {
    if (expiredStratPostIds.has(stratPost.id)) continue;
    try {
      const signups = await getSignupsForPost(stratPost.id);
      const payload = await buildStratMessage(
        stratPost.raids?.name || 'Raid',
        stratPost.teams?.name || 'Strat',
        signups,
        stratPost.creator_name || null,
        stratPost.id,
        stratPost.team_id,
        { createdAt: stratPost.created_at, disableAllButtons: true }
      );
      await updateStratPostEmbeds(stratPost, payload);
      expiredStratPostIds.add(stratPost.id);
    } catch (e) {
      console.error(`[Bot] expireRaidPostButtons error: strat_post_id=${stratPost.id}`, e.message);
    }
  }
}

// ─── event: ready ───────────────────────────────────────────────────────────
client.once('ready', () => {
  console.log(`[Bot] Ready: ${client.user.tag}`);
  setInterval(expireOnline, 60 * 1000);
  setInterval(expireRaidPostButtons, 60 * 1000);

  supabase
    .channel('players-realtime-sync')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'players' },
      payload => {
        const row = payload.new?.team_id ? payload.new : payload.old;
        const teamId = row?.team_id;
        if (!teamId) return;

        queueRealtimeRefresh(teamId);
      }
    )
    .subscribe((status, err) => {
      if (err) {
        console.error('[Bot] players realtime subscribe error:', err.message || err);
        return;
      }

      console.log(`[Bot] players realtime status: ${status}`);
    });

  supabase
    .channel('raid-room-events-sync')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'raid_room_events' },
      payload => {
        if (!payload.new) return;

        notifyHostOfWebsiteRoomEvent(payload.new).catch(e =>
          console.error('[Bot] raid_room_events notify error:', e.message)
        );
      }
    )
    .subscribe((status, err) => {
      if (err) {
        console.error('[Bot] raid_room_events subscribe error:', err.message || err);
        return;
      }

      console.log(`[Bot] raid_room_events status: ${status}`);
    });
});

// ─── event: auto-join threads + sync strat posts ─────────────────────────────
client.on('threadCreate', async thread => {
  try {
    await thread.join();
    console.log(`[Bot] Joined thread: ${thread.name}`);

    let starterMsg = null;
    for (let i = 0; i < 10; i++) {
      try {
        starterMsg = await thread.fetchStarterMessage();
        if (starterMsg) break;
      } catch (e) {}
      await sleep(1000);
    }

    if (!starterMsg) {
      console.warn(`[Bot] threadCreate: starter message not found for thread ${thread.id}`);
      return;
    }

    let matchedPost = null;
    for (let i = 0; i < 10; i++) {
      const { data } = await supabase
        .from('strat_posts')
        .select('*, raids(name), teams(name)')
        .eq('message_id', starterMsg.id)
        .maybeSingle();

      if (data) {
        matchedPost = data;
        break;
      }

      await sleep(1000);
    }

    if (!matchedPost) {
      console.warn(`[Bot] threadCreate: no strat_post matched starter message ${starterMsg.id}`);
      return;
    }

    if (matchedPost.thread_message_id) {
      console.log(`[Bot] threadCreate: thread copy already exists for strat_post ${matchedPost.id}`);
      return;
    }

    const raidName = matchedPost.raids?.name || '';
    const teamName = matchedPost.teams?.name || '';
    const signups = await getSignupsForPost(matchedPost.id);

    const msgPayload = await buildStratMessage(
      raidName,
      teamName,
      signups,
      matchedPost.creator_name || null,
      matchedPost.id,
      matchedPost.team_id,
      { createdAt: matchedPost.created_at }
    );

    const threadMsg = await thread.send(msgPayload);

    await supabase
      .from('strat_posts')
      .update({
        thread_message_id: threadMsg.id,
        thread_channel_id: thread.id,
      })
      .eq('id', matchedPost.id);

    console.log(`[Bot] Synced strat post to thread: ${thread.name}`);
  } catch (e) {
    console.error('[Bot] threadCreate error:', e.message);
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isAutocomplete()) return;

  const { raidsCache, teamsCache } = await getRaidConfig();

  if (interaction.commandName === 'raid' || interaction.commandName === 'position' || interaction.commandName === 'strat') {
    const focused = interaction.options.getFocused(true);

    if (focused.name === 'raid') {
      const choices = raidsCache
        .filter(r => r.name.toLowerCase().includes(focused.value.toLowerCase()))
        .slice(0, 25)
        .map(r => ({ name: `${r.icon} ${r.name}`, value: String(r.id) }));
      await interaction.respond(choices);
    }

    if (focused.name === 'strat') {
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

client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand() && interaction.commandName === 'id') {
    const gameId = interaction.options.getString('game_id');
    const discordId = interaction.user.id;
    const discordUsername = interaction.user.username;

    if (!gameId) {
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

  if (interaction.isChatInputCommand() && interaction.commandName === 'raid') {
    const raidId = parseInt(interaction.options.getString('raid'));
    const teamId = parseInt(interaction.options.getString('strat'));

    const { raidsCache, teamsCache } = await getRaidConfig();
    const raid = raidsCache.find(r => r.id === raidId);
    const team = teamsCache.find(t => t.id === teamId);

    if (!raid || !team) {
      await interaction.reply({ content: '❌ Raid or strategy not found.', flags: 64 });
      return;
    }

    await interaction.deferReply();

    const { data: creatorBinding } = await supabase
      .from('user_bindings').select('game_id').eq('discord_id', interaction.user.id).single();
    const creatorName = creatorBinding?.game_id || interaction.user.username;

    const { data: stratPost, error } = await supabase
      .from('strat_posts')
      .insert({
        message_id: '0',
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
      await interaction.editReply({ content: '❌ Failed to create post.' });
      return;
    }

    // Quick post first so EasyThreads can catch it sooner
    const quickPayload = buildQuickRaidMessage(raid.name, team.name, creatorName);
    await interaction.editReply(quickPayload);
    const msg = await interaction.fetchReply();

    await supabase.from('strat_posts').update({ message_id: msg.id }).eq('id', stratPost.id);
    const synced = await syncRaidPostToWebsite({
      messageId: msg.id,
      channelId: interaction.channelId,
      guildId: interaction.guildId,
      discordUsername: interaction.user.username,
      ign: creatorName,
      bossName: raid.name,
      teamId,
      postedAt: new Date().toISOString(),
    });
    if (!synced) {
      try {
        await msg.delete().catch(() => {});
        await supabase.from('strat_posts').delete().eq('id', stratPost.id);
      } catch (cleanupError) {
        console.error('[Bot] /raid cleanup after sync failure error:', cleanupError.message);
      }
      await interaction.followUp({ content: '❌ Failed to sync the raid post to the website. Please try again.', flags: 64 });
      return;
    }

    // Replace quick version with full version after sync
    const fullPayload = await buildStratMessage(
      raid.name,
      team.name,
      {},
      creatorName,
      stratPost.id,
      teamId,
      { createdAt: stratPost.created_at }
    );
    await msg.edit(fullPayload);

    console.log(`[Bot] Strat post created: ${stratPost.id} | ${raid.name} ${team.name}`);
    return;
  }

  if (interaction.isChatInputCommand() && interaction.commandName === 'delete') {
    const messageId = interaction.options.getString('message_id');

    const { data: stratPost } = await supabase
      .from('strat_posts')
      .select('*')
      .eq('message_id', messageId)
      .single();

    if (!stratPost) {
      await interaction.reply({ content: '❌ Raid post not found.', flags: 64 });
      return;
    }

    const channel = interaction.guild?.channels?.cache.get(stratPost.channel_id);
    try {
      const msg = await channel?.messages?.fetch(messageId);
      if (msg) await msg.delete();
    } catch (e) {
      console.error('[Bot] Failed to delete message:', e.message);
    }

    const { data: signups } = await supabase
      .from('discord_signups')
      .select('position, game_id')
      .eq('strat_post_id', stratPost.id);

    if (signups?.length) {
      const { raidsCache } = await getRaidConfig();
      const raid = raidsCache.find(r => r.id === stratPost.raid_id);
      if (raid) {
        for (const signup of signups) {
          await supabase.from('players')
            .update({ in_room: false, online: false, online_until: null })
            .eq('boss_name', raid.name)
            .eq('team_id', stratPost.team_id)
            .eq('position', signup.position)
            .eq('player_name', signup.game_id);
        }
      }
    }

    await deleteWebsitePost(messageId);
    await supabase.from('discord_signups').delete().eq('strat_post_id', stratPost.id);
    await supabase.from('strat_posts').delete().eq('id', stratPost.id);

    await interaction.reply({ content: '✅ Raid post deleted.', flags: 64 });
    return;
  }

  if (interaction.isChatInputCommand() && interaction.commandName === 'position') {
    const raidId   = parseInt(interaction.options.getString('raid'));
    const teamId   = parseInt(interaction.options.getString('strat'));
    const position = interaction.options.getString('position');
    const discordId = interaction.user.id;
    const discordUsername = interaction.user.username;

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

    {
      const { error } = await supabase.from('players').upsert({
        boss_name: raid.name,
        team_id: teamId,
        position,
        player_name: binding.game_id,
        discord_username: discordUsername,
        in_room: false,
        online: false,
        online_until: null,
        last_seen: now,
        joined_at: now,
      }, { onConflict: 'boss_name,team_id,position,player_name' });

      if (error) {
        await interaction.reply({ content: '❌ Failed to sync to website. Please try again.', flags: 64 });
        console.error('[Bot] /position sync error:', error.message, error.details, error.hint);
        return;
      }
    }

    const playerListUrl = `https://pokemmo-raid-team-finder.vercel.app/?boss=${encodeURIComponent(raid.name)}&team=${teamId}`;
    await interaction.reply({
      content: `✅ Joined **${position}** for **${raid.name} — ${team.name}**!\nGame ID: ${binding.game_id}\nCheck the player list: ${playerListUrl}`,
      flags: 64,
    });
    console.log(`[/position] ${binding.game_id} → ${raid.name} ${team.name} ${position}`);
    refreshStratBoards(teamId).catch(e => console.error('[Bot] refresh error:', e.message));
    return;
  }

  if (interaction.isChatInputCommand() && interaction.commandName === 'myposition') {
    const discordId = interaction.user.id;
    const { data: binding } = await supabase
      .from('user_bindings').select('game_id').eq('discord_id', discordId).single();
    if (!binding) {
      await interaction.reply({ content: '❌ No game ID linked.\nRun `/id <your_game_id>` first.', flags: 64 });
      return;
    }
    const msg = await buildMyPositionMessage(binding.game_id);
    await interaction.reply({ ...msg, flags: 64 });
    return;
  }

  if (interaction.isChatInputCommand() && (interaction.commandName === 'online' || interaction.commandName === 'offline')) {
    const discordId = interaction.user.id;
    const setOnline = interaction.commandName === 'online';
    const { data: binding } = await supabase
      .from('user_bindings').select('game_id').eq('discord_id', discordId).single();
    if (!binding) {
      await interaction.reply({ content: '❌ No game ID linked.\nRun `/id <your_game_id>` first.', flags: 64 });
      return;
    }

    const teamIds = await setAllPlayerEntriesOnlineState(binding.game_id, setOnline);
    if (teamIds.length === 0) {
      await interaction.reply({ content: '❌ No joined positions found.', flags: 64 });
      return;
    }

    for (const teamId of teamIds) {
      refreshStratBoards(teamId).catch(() => {});
    }

    await interaction.reply({
      content: setOnline
        ? '✅ All your joined positions are now online for 30 minutes.'
        : '✅ All your joined positions are now offline.',
      flags: 64,
    });
    return;
  }

  if (interaction.isChatInputCommand() && interaction.commandName === 'strat') {
    const raidId = parseInt(interaction.options.getString('raid'));
    const teamId = parseInt(interaction.options.getString('strat'));

    const { raidsCache, teamsCache } = await getRaidConfig();
    const raid = raidsCache.find(r => r.id === raidId);
    const team = teamsCache.find(t => t.id === teamId);

    if (!raid || !team) {
      await interaction.reply({ content: '❌ Raid or strategy not found.', flags: 64 });
      return;
    }

    await interaction.deferReply();

    const boardMsg = await buildStratBoard(raid.name, team.name, teamId, raid.name);
    const msg = await interaction.followUp(boardMsg);

    const { error } = await supabase.from('strat_boards').insert({
      message_id: msg.id,
      channel_id: interaction.channelId,
      guild_id: interaction.guildId,
      raid_id: raidId,
      team_id: teamId,
    });

    if (error) {
      console.error('[Bot] strat_boards insert error:', error.message);
    } else {
      console.log(`[Bot] Strat board created: ${raid.name} ${team.name}`);
    }
    return;
  }

  if (!interaction.isButton()) return;

  const parts = interaction.customId.split(':');
  const action = parts[0];
  const value = parts[1];
  const sidOverride = parts[2];

  const discordId = interaction.user.id;
  const discordUsername = interaction.user.username;

  if (action === 'board' && value !== 'leave') {
    const position = value;
    const teamId = parseInt(sidOverride);

    const { data: binding } = await supabase
      .from('user_bindings').select('game_id').eq('discord_id', discordId).single();
    if (!binding) {
      await interaction.reply({ content: '❌ No game ID linked.\nRun `/id <your_game_id>` first.', flags: 64 });
      return;
    }

    const { data: board } = await supabase
      .from('strat_boards')
      .select('*, raids(name), teams(name)')
      .eq('team_id', teamId)
      .eq('message_id', interaction.message.id)
      .single();

    if (!board) {
      await interaction.reply({ content: '❌ Board not found.', flags: 64 });
      return;
    }

    const raidName = board.raids?.name || '';
    const now = new Date().toISOString();

    await interaction.deferUpdate();
    const { data: existing } = await supabase
      .from('players')
      .select('id')
      .eq('boss_name', raidName)
      .eq('team_id', teamId)
      .eq('position', position)
      .eq('player_name', binding.game_id)
      .maybeSingle();

    if (existing) {
      await supabase.from('players').delete().eq('id', existing.id);
    } else {
      const { error } = await supabase.from('players').upsert({
        boss_name: raidName,
        team_id: teamId,
        position,
        player_name: binding.game_id,
        discord_username: discordUsername,
        in_room: false,
        online: false,
        online_until: null,
        last_seen: now,
        joined_at: now,
      }, { onConflict: 'boss_name,team_id,position,player_name' });
      if (error) {
        await interaction.reply({ content: '❌ Failed. Please try again.', flags: 64 });
        return;
      }
    }

    await refreshStratBoards(teamId);
    return;
  }

  if (action === 'board' && value === 'leave') {
    const teamId = parseInt(sidOverride);

    const { data: binding } = await supabase
      .from('user_bindings').select('game_id').eq('discord_id', discordId).single();
    if (!binding) {
      await interaction.reply({ content: '❌ No game ID linked.', flags: 64 });
      return;
    }

    const { data: board } = await supabase
      .from('strat_boards')
      .select('*, raids(name)')
      .eq('team_id', teamId)
      .eq('message_id', interaction.message.id)
      .single();

    if (!board) { await interaction.reply({ content: '❌ Board not found.', flags: 64 }); return; }

    await interaction.deferUpdate();

    await supabase.from('players').delete()
      .eq('boss_name', board.raids?.name || '')
      .eq('team_id', teamId)
      .eq('player_name', binding.game_id);

    await refreshStratBoards(teamId);
    return;
  }

  if (action === 'boardonline') {
    const setOnline = value === 'on';
    const teamId = parseInt(sidOverride);

    const { data: binding } = await supabase
      .from('user_bindings').select('game_id').eq('discord_id', discordId).single();
    if (!binding) {
      await interaction.reply({ content: '❌ No game ID linked.\nRun `/id <your_game_id>` first.', flags: 64 });
      return;
    }

    const { data: board } = await supabase
      .from('strat_boards')
      .select('*, raids(name)')
      .eq('team_id', teamId)
      .eq('message_id', interaction.message.id)
      .single();

    if (!board) {
      await interaction.reply({ content: '❌ Board not found.', flags: 64 });
      return;
    }

    const raidName = board.raids?.name || '';
    const { data: myEntries } = await supabase
      .from('players')
      .select('id')
      .eq('boss_name', raidName)
      .eq('team_id', teamId)
      .eq('player_name', binding.game_id);

    if (!myEntries || myEntries.length === 0) {
      await interaction.reply({ content: '❌ You have not joined any position in this strat yet.', flags: 64 });
      return;
    }

    const now = new Date().toISOString();
    await interaction.deferUpdate();
    const onlineUntil = setOnline ? new Date(Date.now() + 30 * 60 * 1000).toISOString() : null;

    for (const e of myEntries) {
      await supabase.from('players')
        .update({ online: setOnline, last_seen: now, online_until: onlineUntil })
        .eq('id', e.id);
    }

    await refreshStratBoards(teamId);
    return;
  }

  if (action === 'myremove' || action === 'mytoggle' || action === 'mypage') {
    const { data: binding } = await supabase
      .from('user_bindings').select('game_id').eq('discord_id', discordId).single();
    if (!binding) {
      await interaction.reply({ content: '❌ No game ID linked.', flags: 64 });
      return;
    }

    if (action === 'mypage') {
      const direction = value;
      const currentPage = parseInt(parts[2]) || 0;
      const newPage = direction === 'next' ? currentPage + 1 : currentPage - 1;
      const msg = await buildMyPositionMessage(binding.game_id, newPage);
      await interaction.update(msg);
      return;
    }

    const entryId = value;
    const currentPage = parseInt(parts[2]) || 0;

    const { data: entry } = await supabase
      .from('players').select('id, boss_name, team_id, position, online, player_name')
      .eq('id', entryId).eq('player_name', binding.game_id).single();

    if (!entry) {
      await interaction.reply({ content: '❌ Entry not found or does not belong to you.', flags: 64 });
      return;
    }

    if (action === 'myremove') {
      await supabase.from('players').delete().eq('id', entryId);
      const msg = await buildMyPositionMessage(binding.game_id, currentPage);
      await interaction.update(msg);
      return;
    }

    if (action === 'mytoggle') {
      const newOnline = !entry.online;
      const onlineUntil = newOnline ? new Date(Date.now() + 30 * 60 * 1000).toISOString() : null;
      await supabase.from('players')
        .update({ online: newOnline, last_seen: new Date().toISOString(), online_until: onlineUntil })
        .eq('id', entryId);
      const msg = await buildMyPositionMessage(binding.game_id, currentPage);
      await interaction.update(msg);
      return;
    }
  }

  let stratPost;
  let isFromThread = false;

  if (sidOverride) {
    const { data } = await supabase
      .from('strat_posts')
      .select('*, raids(name, icon), teams(name), creator_name')
      .eq('id', parseInt(sidOverride))
      .single();
    stratPost = data;
  } else {
    const { data: byMsg } = await supabase
      .from('strat_posts')
      .select('*, raids(name, icon), teams(name), creator_name')
      .eq('message_id', interaction.message.id)
      .maybeSingle();

    if (byMsg) {
      stratPost = byMsg;
    } else {
      const { data: byThread } = await supabase
        .from('strat_posts')
        .select('*, raids(name, icon), teams(name), creator_name')
        .eq('thread_message_id', interaction.message.id)
        .maybeSingle();
      if (byThread) {
        stratPost = byThread;
        isFromThread = true;
      }
    }
  }

  if (!stratPost) return;

  const updateAndSync = async (payload) => {
    if (isFromThread) {
      await interaction.message.edit(payload);
      await interaction.deferUpdate().catch(() => {});
      try {
        const ch = await client.channels.fetch(stratPost.channel_id);
        const orig = await ch.messages.fetch(stratPost.message_id);
        await orig.edit(payload);
      } catch (e) {}
    } else {
      await interaction.update(payload);
      if (stratPost.thread_message_id && stratPost.thread_channel_id) {
        try {
          const threadCh = await client.channels.fetch(stratPost.thread_channel_id);
          const threadMsg = await threadCh.messages.fetch(stratPost.thread_message_id);
          await threadMsg.edit(payload);
        } catch (e) {}
      }
    }
  };

  const raidName = stratPost.raids?.name || 'Raid';
  const teamName = stratPost.teams?.name || 'Strat';
  const creatorId = stratPost.created_by_discord_id || null;

  if (action !== 'signup') return;

  if (isRaidPostExpired(stratPost.created_at)) {
    const signups = await getSignupsForPost(stratPost.id);
    const updated = await buildStratMessage(raidName, teamName, signups, stratPost.creator_name || null, stratPost.id, stratPost.team_id, { createdAt: stratPost.created_at, disableAllButtons: true });
    await updateAndSync(updated);
    await interaction.followUp({ content: '❌ This raid post is closed after 2 hours.', flags: 64 });
    return;
  }

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

  if (value === 'cancel') {
    const isCreator = creatorId && discordId === creatorId;

    if (isCreator) {
      const { data: allSignups } = await supabase
        .from('discord_signups')
        .select('position, game_id')
        .eq('strat_post_id', stratPost.id);

      await supabase.from('discord_signups').delete()
        .eq('strat_post_id', stratPost.id);

      if (allSignups?.length && stratPost.raid_id) {
        const { raidsCache } = await getRaidConfig();
        const raid = raidsCache.find(r => r.id === stratPost.raid_id);
        if (raid) {
          for (const s of allSignups) {
            await supabase.from('players').update({ in_room: false, online: false, online_until: null })
              .eq('boss_name', raid.name)
              .eq('team_id', stratPost.team_id)
              .eq('position', s.position)
              .eq('player_name', s.game_id);
          }
        }
      }
    } else {
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
            await supabase.from('players').update({ in_room: false, online: false, online_until: null })
              .eq('boss_name', raid.name)
              .eq('team_id', stratPost.team_id)
              .eq('position', s.position)
              .eq('player_name', binding.game_id);
          }
        }
      }
    }

    const signups = await getSignupsForPost(stratPost.id);
    const updated = await buildStratMessage(raidName, teamName, signups, stratPost.creator_name || null, null, stratPost.team_id, { createdAt: stratPost.created_at });
    await updateAndSync(updated);
    if (!isCreator && creatorId) {
      await sendHostRaidNotification(
        stratPost,
        `🔔 **${discordUsername}** (${binding.game_id}) left your raid post.\n⚔️ ${raidName} — ${teamName}`,
        binding.game_id
      );
    }
    if (isCreator) {
      await interaction.followUp({ content: '✅ All signups cleared.', flags: 64 });
    } else {
      await interaction.followUp({ content: '✅ You have left the raid.', flags: 64 });
    }
    return;
  }

  const position = value;

  const { data: mySignup } = await supabase
    .from('discord_signups')
    .select('id')
    .eq('strat_post_id', stratPost.id)
    .eq('discord_id', discordId)
    .eq('position', position)
    .maybeSingle();

  if (mySignup) {
    await supabase.from('discord_signups').delete().eq('id', mySignup.id);
    const { raidsCache } = await getRaidConfig();
    const raid = raidsCache.find(r => r.id === stratPost.raid_id);
    if (raid) {
      await supabase.from('players').update({ in_room: false, online: false, online_until: null })
        .eq('boss_name', raid.name)
        .eq('team_id', stratPost.team_id)
        .eq('position', position)
        .eq('player_name', binding.game_id);
    }
    const signups = await getSignupsForPost(stratPost.id);
    const updated = await buildStratMessage(raidName, teamName, signups, stratPost.creator_name || null, null, stratPost.team_id, { createdAt: stratPost.created_at });
    await updateAndSync(updated);
    if (creatorId && creatorId !== discordId) {
      await sendHostRaidNotification(
        stratPost,
        `🔔 **${discordUsername}** (${binding.game_id}) left **${position}** in your raid post.\n⚔️ ${raidName} — ${teamName}`,
        binding.game_id
      );
    }
    await interaction.followUp({ content: `✅ Removed from **${position}**.`, flags: 64 });
    return;
  }

    const { error: insertError } = await supabase.from('discord_signups').insert({
    strat_post_id: stratPost.id,
    discord_id: discordId,
    discord_username: discordUsername,
    game_id: binding.game_id,
    position,
  });

  if (insertError) {
    if (insertError.code === '23505') {
      const signups = await getSignupsForPost(stratPost.id);
      const updated = await buildStratMessage(
        raidName,
        teamName,
        signups,
        stratPost.creator_name || null,
        null,
        stratPost.team_id,
        { createdAt: stratPost.created_at }
      );
      await updateAndSync(updated);
      await interaction.reply({ content: `❌ **${position}** is already taken.`, flags: 64 });
      return;
    }

    console.error('[Bot] signup insert error:', insertError.message, insertError.code);
    await interaction.reply({ content: '❌ Signup failed. Please try again.', flags: 64 });
    return;
  }

  const { raidsCache: rc } = await getRaidConfig();
  const raidForSync = rc.find(r => r.id === stratPost.raid_id);
  if (raidForSync) {
    const now = new Date().toISOString();
    await supabase.from('players').upsert({
      boss_name: raidForSync.name,
      team_id: stratPost.team_id,
      position,
      player_name: binding.game_id,
      discord_username: discordUsername,
      in_room: true,
      online: false,
      online_until: null,
      last_seen: now,
      joined_at: now,
    }, { onConflict: 'boss_name,team_id,position,player_name' });
  }

  const signups = await getSignupsForPost(stratPost.id);
  const updated = await buildStratMessage(raidName, teamName, signups, stratPost.creator_name || null, null, stratPost.team_id, { createdAt: stratPost.created_at });
  await updateAndSync(updated);
  await interaction.followUp({ content: `✅ Joined **${position}**! Game ID: ${binding.game_id}`, flags: 64 });

  refreshStratBoards(stratPost.team_id).catch(e => console.error('[Bot] refresh error:', e.message));

  if (creatorId && creatorId !== discordId) {
    await sendHostRaidNotification(
      stratPost,
      `🔔 **${discordUsername}** (${binding.game_id}) joined **${position}** in your raid post!\n⚔️ ${raidName} — ${teamName}`,
      binding.game_id
    );
    return;
  }
});

client.on('messageDelete', async message => {
  try {
    await deleteWebsitePost(message.id);

    const { data: stratPost } = await supabase
      .from('strat_posts')
      .select('id, raid_id, team_id')
      .eq('message_id', message.id)
      .maybeSingle();

    if (stratPost) {
      const { data: signups } = await supabase
        .from('discord_signups')
        .select('game_id')
        .eq('strat_post_id', stratPost.id);

      const { raidsCache } = await getRaidConfig();
      const raid = raidsCache.find(r => r.id === stratPost.raid_id);

      if (raid && signups?.length) {
        const playerNames = [...new Set(signups.map(s => s.game_id).filter(Boolean))];
        if (playerNames.length > 0) {
          await supabase.from('players')
            .update({ in_room: false, online: false, online_until: null })
            .eq('boss_name', raid.name)
            .eq('team_id', stratPost.team_id)
            .in('player_name', playerNames);
        }
      }

      await supabase.from('discord_signups').delete().eq('strat_post_id', stratPost.id);
      await supabase.from('strat_posts').delete().eq('id', stratPost.id);
      console.log(`[Bot] Synced deleted raid post: ${message.id}`);
    }
  } catch (e) {
    console.error('[Bot] messageDelete sync error:', e.message);
  }
});

async function expireOnline() {
  const now = new Date().toISOString();
  const { data: expired } = await supabase
    .from('players')
    .select('id, team_id')
    .eq('online', true)
    .not('online_until', 'is', null)
    .lt('online_until', now);

  if (!expired || expired.length === 0) return;

  await supabase.from('players')
    .update({ online: false, online_until: null })
    .in('id', expired.map(e => e.id));

  const teamIds = [...new Set(expired.map(e => e.team_id))];
  for (const tid of teamIds) {
    refreshStratBoards(tid).catch(() => {});
  }
  console.log(`[Bot] Expired online for ${expired.length} player(s)`);
}

registerCommands().then(() => {
  client.login(process.env.DISCORD_TOKEN);
});
