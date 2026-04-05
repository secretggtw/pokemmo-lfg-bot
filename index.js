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
  heatran:'Heatran', cresselia:'Cresselia', meloetta:'Meloetta',
  cobalion:'Cobalion', terrakion:'Terrakion', virizion:'Virizion',
  octi:'Heatran', octilleri:'Heatran', octillery:'Heatran',
  kyurem:'Kyurem', reshiram:'Reshiram', zekrom:'Zekrom',
  landorus:'Landorus', thundurus:'Thundurus', tornadus:'Tornadus',
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
  if (/every\s*pos|all\s*pos|any\s*pos|fill any|any p\b/i.test(lower)) return ['P1','P2','P3','P4'];
  const positions = [];
  for (const m of lower.matchAll(/p\s*([1-4])/g)) {
    const p = `P${m[1]}`;
    if (!positions.includes(p)) positions.push(p);
  }
  return positions;
}

function parseIGN(content) {
  // ign: xxx 或 ign xxx
  const ignMatch = content.match(/ign\s*:?\s*([^\s,@\n]+)/i);
  if (ignMatch) return ignMatch[1];
  return null;
}

// 單一頻道：必須同時有 LFG 關鍵字 + boss 名稱（或已被 keywords 匹配）
function isValidLFGPost(content, bossName) {
  const lower = content.toLowerCase();
  const hasLFGKeyword = /\b(lfg|lf\b|lf\+|looking for|\d\/4)\b/i.test(lower);
  const hasBoss = !!bossName;
  return hasLFGKeyword && hasBoss;
}

async function getStratName(teamId) {
  if (!teamId) return null;
  const { data } = await supabase.from('teams').select('name').eq('id', teamId).maybeSingle();
  return data?.name || null;
}

// 10 分鐘內同一用戶同一頻道的 post
async function findRecentPost(displayName, channelId, serverId) {
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data } = await supabase.from('lfg_posts')
    .select('id, raw_message')
    .eq('discord_server_id', serverId)
    .eq('discord_channel_id', channelId)
    .eq('discord_username', displayName)
    .eq('is_stale', false)
    .gte('posted_at', tenMinAgo)
    .order('posted_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data || null;
}

async function handleMessage(message) {
  if (message.author.bot) return;
  const serverId = message.guildId;
  const config = SERVER_CONFIGS[serverId];
  if (!config) return;
  const content = message.content.trim();
  if (!content) return;

  await message.member?.fetch().catch(() => {});
  const displayName = message.member?.nickname
    || message.author.globalName
    || message.author.username;

  const avatarUrl = message.author.displayAvatarURL({ size: 64, extension: 'png' });

  let bossName = null;
  let teamId = null;

  // 先用 keywords 匹配（兩種 server 都先試）
  const kwMatch = await matchByKeywords(content);
  if (kwMatch) { bossName = kwMatch.bossName; teamId = kwMatch.teamId; }

  if (config.type === 'split') {
    const chName = message.channel.name || '';
    if (!chName.startsWith('lf-') && !chName.includes('-team')) return;
    // split 頻道：從頻道名補 boss（keyword 沒匹配到的話）
    if (!bossName) bossName = bossByText(chName);
    if (!bossName) return;
  } else {
    // 單一頻道：嚴格過濾，必須有 LFG 關鍵字 + boss 名稱
    if (config.channelIds.length > 0 && !config.channelIds.includes(message.channelId)) return;
    if (!bossName) bossName = bossByText(content);
    if (!isValidLFGPost(content, bossName)) return;
  }

  const positions = parsePositions(content);
  const ign = parseIGN(content);
  const stratName = await getStratName(teamId);
  const jumpUrl = `https://discord.com/channels/${serverId}/${message.channelId}/${message.id}`;
  const serverName = message.guild?.name || serverId;
  const channelName = message.channel?.name || message.channelId;

  console.log(`[LFG] ${displayName} | ${bossName} | ${stratName||'?'} | pos:${positions.join(',')} | ign:${ign||'none'}`);

  // 10 分鐘內同一用戶：把新訊息加到 messages 陣列
  const existing = await findRecentPost(displayName, message.channelId, serverId);

  if (existing) {
    // 取得現有 messages，加入新訊息
    const { data: existingPost } = await supabase.from('lfg_posts')
      .select('messages')
      .eq('id', existing.id)
      .single();

    const messages = existingPost?.messages || [existing.raw_message];
    if (!messages.includes(content)) messages.push(content);

    const updatedPositions = positions.length > 0 ? positions : undefined;
    await supabase.from('lfg_posts').update({
      raw_message: content,
      messages,
      ...(updatedPositions && { positions: updatedPositions }),
      ...(ign && { ign }),
      discord_jump_url: jumpUrl,
      posted_at: new Date(message.createdTimestamp).toISOString(),
      is_stale: false,
    }).eq('id', existing.id);
  } else {
    await supabase.from('lfg_posts').upsert({
      discord_msg_id: message.id,
      discord_server_id: serverId,
      discord_channel_id: message.channelId,
      discord_username: displayName,
      avatar_url: avatarUrl,
      ign, boss_name: bossName, team_id: teamId, strat_name: stratName,
      positions, raw_message: content,
      messages: [content],
      posted_at: new Date(message.createdTimestamp).toISOString(),
      is_stale: false,
      discord_jump_url: jumpUrl,
      server_name: serverName,
      channel_name: channelName,
    }, { onConflict: 'discord_msg_id' });
  }
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
