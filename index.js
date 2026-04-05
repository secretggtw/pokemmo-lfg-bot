const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ===== Boss 名稱對應 =====
const BOSS_ALIASES = {
  heatran:   'Heatran',
  cresselia: 'Cresselia',
  meloetta:  'Meloetta',
  cobalion:  'Cobalion',
  terrakion: 'Terrakion',
  virizion:  'Virizion',
};

// ===== Server 設定 =====
// SERVER_CONFIGS: { serverId: { type: 'split' | 'single', channelIds: [...] } }
const SERVER_CONFIGS = {
  [process.env.SERVER_A_ID]: {
    type: 'split',       // 每個 boss 有獨立頻道
    // channelIds 為空代表監聽所有 lf- 開頭的頻道
  },
  [process.env.SERVER_B_ID]: {
    type: 'single',      // 所有 LFG 在同一頻道
    channelIds: (process.env.SERVER_B_CHANNEL_IDS || '').split(',').filter(Boolean),
  },
};

// ===== 從頻道名稱判斷 Boss =====
function bossByChannelName(channelName) {
  const name = channelName.toLowerCase();
  for (const [alias, boss] of Object.entries(BOSS_ALIASES)) {
    if (name.includes(alias)) return boss;
  }
  return null;
}

// ===== 從訊息內容解析 Boss =====
function bossByContent(content) {
  const lower = content.toLowerCase();
  for (const [alias, boss] of Object.entries(BOSS_ALIASES)) {
    if (lower.includes(alias)) return boss;
  }
  return null;
}

// ===== 解析 Position =====
function parsePositions(content) {
  const lower = content.toLowerCase();
  const positions = [];

  // "every position" / "all position" / "any position"
  if (/every\s*pos|all\s*pos|any\s*pos/i.test(lower)) {
    return ['P1', 'P2', 'P3', 'P4'];
  }

  // P1, P2, P3, P4 (大小寫, 含 "p 1" 格式)
  const matches = lower.matchAll(/p\s*([1-4])/g);
  for (const m of matches) {
    const p = `P${m[1]}`;
    if (!positions.includes(p)) positions.push(p);
  }

  return positions;
}

// ===== 解析 IGN =====
function parseIGN(content, username) {
  // ign: xxx 或 ign xxx
  const ignMatch = content.match(/ign\s*:?\s*(\S+)/i);
  if (ignMatch) return ignMatch[1];

  // 找 "i am xxx" / "i'm xxx"
  const iamMatch = content.match(/i(?:'m| am)\s+(\w+)/i);
  if (iamMatch) return iamMatch[1];

  return username; // fallback: Discord username
}

// ===== 判斷是否為 LFG 訊息 =====
function isLFG(content) {
  return /\b(lfg|lf\b|lf\+|looking for|lf[g]?\s)/i.test(content);
}

// ===== 主要處理邏輯 =====
async function handleMessage(message) {
  if (message.author.bot) return;

  const serverId = message.guildId;
  const config = SERVER_CONFIGS[serverId];
  if (!config) return; // 不在監聽的 server

  const content = message.content.trim();
  if (!content) return;

  let bossName = null;

  if (config.type === 'split') {
    // 分開頻道：從頻道名判斷 Boss，且頻道名要有 lf-
    const channelName = message.channel.name || '';
    if (!channelName.startsWith('lf-') && !channelName.includes('-team')) return;
    bossName = bossByChannelName(channelName);
    if (!bossName) return; // 不認識的頻道直接跳過
    // 不需要 isLFG 檢查，進頻道就算
  } else {
    // 單一頻道：要在指定頻道，且訊息要像 LFG
    if (config.channelIds.length > 0 && !config.channelIds.includes(message.channelId)) return;
    if (!isLFG(content)) return;
    bossName = bossByContent(content);
    if (!bossName) return;
  }

  const positions = parsePositions(content);
  const ign = parseIGN(content, message.author.username);

  console.log(`[LFG] ${message.author.username} | ${bossName} | pos: ${positions.join(',')} | ign: ${ign}`);

  const { error } = await supabase.from('lfg_posts').upsert({
    discord_msg_id:     message.id,
    discord_server_id:  serverId,
    discord_channel_id: message.channelId,
    discord_username:   message.author.username,
    ign,
    boss_name:          bossName,
    positions,
    raw_message:        content,
    posted_at:          new Date(message.createdTimestamp).toISOString(),
    is_stale:           false,
  }, { onConflict: 'discord_msg_id' });

  if (error) console.error('Supabase error:', error.message);
}

// ===== 定時把 2 小時以上的設為 stale =====
async function markStale() {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  await supabase
    .from('lfg_posts')
    .update({ is_stale: true })
    .eq('is_stale', false)
    .lt('posted_at', twoHoursAgo);
}

// ===== Bot 事件 =====
client.once('ready', () => {
  console.log(`Bot ready: ${client.user.tag}`);
  // 每10分鐘跑一次 stale 檢查
  setInterval(markStale, 10 * 60 * 1000);
});

client.on('messageCreate', handleMessage);

client.login(process.env.DISCORD_TOKEN);
