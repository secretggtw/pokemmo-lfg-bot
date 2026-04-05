const { Client, GatewayIntentBits } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

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

const BOSS_ALIASES = {
  heatran:'Heatran',cresselia:'Cresselia',meloetta:'Meloetta',
  cobalion:'Cobalion',terrakion:'Terrakion',virizion:'Virizion',
  octi:'Heatran',octilleri:'Heatran',octillery:'Heatran',
  kyurem:'Kyurem',reshiram:'Reshiram',zekrom:'Zekrom',
  landorus:'Landorus',thundurus:'Thundurus',tornadus:'Tornadus',
};

const SERVER_CONFIGS = {
  [process.env.SERVER_A_ID]: { type: 'split' },
  [process.env.SERVER_B_ID]: {
    type: 'single',
    channelIds: (process.env.SERVER_B_CHANNEL_IDS || '').split(',').filter(Boolean),
  },
};

let keywordsCache = [];
let keywordsCacheTime = 0;

async function getKeywords() {
  if (Date.now() - keywordsCacheTime < 5 * 60 * 1000) return keywordsCache;
  const { data } = await supabase.from('lfg_keywords').select('*');
  keywordsCache = data || [];
  keywordsCacheTime = Date.now();
  return keywordsCache;
}

async function matchByKeywords(content) {
  const lower = content.toLowerCase();
  const keywords = await getKeywords();
  for (const kw of keywords) {
    if (lower.includes(kw.keyword.toLowerCase())) {
      return { bossName: kw.boss_name, teamId: kw.team_id };
    }
  }
  return null;
}

function bossByText(text) {
  const lower = text.toLowerCase();
  for (const [alias, boss] of Object.entries(BOSS_ALIASES)) {
    if (lower.includes(alias)) return boss;
  }
  return null;
}

function parsePositions(content) {
  const lower = content.toLowerCase();
  if (/every\s*pos|all\s*pos|any\s*pos/i.test(lower)) return ['P1','P2','P3','P4'];
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
  const iamMatch = content.match(/i(?:'m| am)\s+(\w+)/i);
  if (iamMatch) return iamMatch[1];
  return displayName;
}

function isLFG(content) {
  return /\b(lfg|lf\b|lf\+|looking for)/i.test(content);
}

async function getStratName(teamId) {
  if (!teamId) return null;
  const { data } = await supabase.from('teams').select('name').eq('id', teamId).maybeSingle();
  return data?.name || null;
}

async function handleMessage(message) {
  if (message.author.bot) return;
  const serverId = message.guildId;
  const config = SERVER_CONFIGS[serverId];
  if (!config) return;
  const content = message.content.trim();
  if (!content) return;

  // 優先用 server nickname，其次 globalName，最後 username
  await message.member?.fetch().catch(()=>{});
  const displayName = message.member?.nickname
    || message.author.globalName
    || message.author.username;

  let bossName = null;
  let teamId = null;

  if (config.type === 'split') {
    const chName = message.channel.name || '';
    if (!chName.startsWith('lf-') && !chName.includes('-team')) return;
    const kwMatch = await matchByKeywords(content);
    if (kwMatch) { bossName = kwMatch.bossName; teamId = kwMatch.teamId; }
    else bossName = bossByText(chName);
    if (!bossName) return;
  } else {
    if (config.channelIds.length > 0 && !config.channelIds.includes(message.channelId)) return;
    if (!isLFG(content)) return;
    const kwMatch = await matchByKeywords(content);
    if (kwMatch) { bossName = kwMatch.bossName; teamId = kwMatch.teamId; }
    else bossName = bossByText(content);
    if (!bossName) return;
  }

  const positions = parsePositions(content);
  const ign = parseIGN(content, displayName);
  const stratName = await getStratName(teamId);
  const jumpUrl = `https://discord.com/channels/${serverId}/${message.channelId}/${message.id}`;
  const serverName = message.guild?.name || serverId;
  const channelName = message.channel?.name || message.channelId;

  console.log(`[LFG] ${displayName} | ${bossName} | ${stratName||'?'} | pos:${positions.join(',')} | ign:${ign}`);

  const { error } = await supabase.from('lfg_posts').upsert({
    discord_msg_id: message.id,
    discord_server_id: serverId,
    discord_channel_id: message.channelId,
    discord_username: displayName,
    ign, boss_name: bossName, team_id: teamId, strat_name: stratName,
    positions, raw_message: content,
    posted_at: new Date(message.createdTimestamp).toISOString(),
    is_stale: false,
    discord_jump_url: jumpUrl,
    server_name: serverName,
    channel_name: channelName,
  }, { onConflict: 'discord_msg_id' });

  if (error) console.error('Supabase error:', error.message);
}

async function markStale() {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  await supabase.from('lfg_posts').update({ is_stale: true })
    .eq('is_stale', false).lt('posted_at', twoHoursAgo);
}

client.once('ready', () => {
  console.log(`Bot ready: ${client.user.tag}`);
  setInterval(markStale, 10 * 60 * 1000);
});

client.on('messageCreate', handleMessage);
client.login(process.env.DISCORD_TOKEN);
