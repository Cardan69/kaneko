const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, UserSelectMenuBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, EmbedBuilder, AttachmentBuilder,
  PermissionFlagsBits, ChannelType, Events, MessageFlags,
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const http = require('http');
require('dotenv').config();

const BUILD_VERSION = '2026-08-28-v4-stats-dashboard';

const DATA_PATH = path.join(__dirname, 'data.json');
const SCREENSHOT_TIMEOUT_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 15 * 60 * 1000;
const COLOR = {
  ink: 0x2b2d31,
  gold: 0xf0c030,
  ok: 0x57f287,
  bad: 0xed4245,
};

const CONTRACTS = [
  { id: 'balloon1', name: 'Балонний транзит І',     amount: 150000 },
  { id: 'trophy1',  name: 'Продажа трофеїв І',      amount: 90000  },
  { id: 'master2',  name: 'Майстер на всі руки ІІ', amount: 230000 },
  { id: 'trophy3',  name: 'Продажа трофеїв ІІІ',    amount: 190000 },
  { id: 'balloon2', name: 'Балонний транзит ІІ',     amount: 185000 },
  { id: 'root2',    name: 'Під корінь ІІ',           amount: 175000 },
];

function env(name) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : null;
}

const CHANNEL_CONTRACTS = env('CHANNEL_CONTRACTS');
const CHANNEL_REVIEW    = env('CHANNEL_REVIEW');
const CHANNEL_PAYOUTS   = env('CHANNEL_PAYOUTS');
const CHANNEL_MEDIA     = env('CHANNEL_MEDIA'); // optional; if empty, bot creates/finds a hidden media channel
const REVIEW_ROLE_ID    = env('REVIEW_ROLE_ID');
let resolvedMediaChannelId = CHANNEL_MEDIA;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// userId -> session
const formState = new Map();
// messageId currently being approved/rejected (prevents double payout)
const inFlight = new Set();

// ─── Persistent store (номер контракту + історія) ─────────────────
function defaultData() {
  return { nextNumber: 1, submissions: [], expenses: [] };
}

function loadData() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    if (!raw || typeof raw !== 'object') return defaultData();
    return {
      nextNumber: Number(raw.nextNumber) > 0 ? Number(raw.nextNumber) : 1,
      submissions: Array.isArray(raw.submissions) ? raw.submissions : [],
      expenses: Array.isArray(raw.expenses) ? raw.expenses : [],
    };
  } catch {
    return defaultData();
  }
}

let writeChain = Promise.resolve();
function withData(mutator) {
  const run = writeChain.then(async () => {
    const data = loadData();
    const result = await mutator(data);
    fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
    return result;
  });
  writeChain = run.then(() => {}, () => {});
  return run;
}

function formatCode(n) {
  return `K-${String(n).padStart(3, '0')}`;
}

async function allocateNumber() {
  return withData((data) => {
    const n = data.nextNumber;
    data.nextNumber = n + 1;
    return n;
  });
}

async function saveSubmission(record) {
  return withData((data) => {
    data.submissions.push(record);
    if (data.submissions.length > 500) {
      data.submissions = data.submissions.slice(-500);
    }
  });
}

async function updateSubmission(number, patch) {
  return withData((data) => {
    const row = data.submissions.find((s) => s.number === number);
    if (row) Object.assign(row, patch);
  });
}

function parseCodeFromFooter(text) {
  const m = String(text || '').match(/K-(\d{3,})/);
  return m ? Number(m[1]) : null;
}

// ─── Helpers ──────────────────────────────────────────────────────
function formatMoney(n) {
  return `$${Number(n).toLocaleString('uk-UA')}`;
}

function calcPayout(amount, count) {
  const safeCount = Math.max(1, count);
  const participantPool = Math.floor(Number(amount) * 0.80);
  const perPerson = Math.floor(participantPool / safeCount);
  const family = Number(amount) - (perPerson * safeCount);
  return { family, perPerson, participantPool };
}


function getSubmissionByNumber(number) {
  const data = loadData();
  return data.submissions.find((s) => Number(s.number) === Number(number)) || null;
}

function getApprovedSubmissions() {
  return loadData().submissions.filter((s) => s.status === 'approved');
}

function familyBalance() {
  return getApprovedSubmissions().reduce((sum, s) => sum + Number(s.familyCredited || 0), 0);
}

function playerStats(userId) {
  const rows = getApprovedSubmissions().filter((s) => (s.members || []).includes(userId));
  let earned = 0;
  let paid = 0;
  let pending = 0;
  let turnover = 0;
  let personalPayoutContracts = 0;
  let familySupportContracts = 0;

  for (const s of rows) {
    turnover += Number(s.amount || 0);

    if (s.payoutChoice === 'family') {
      familySupportContracts += 1;
      continue;
    }

    if (s.payoutChoice !== 'self') continue;
    personalPayoutContracts += 1;

    const amount = Number(s.perPerson || 0);
    earned += amount;
    if (s.payoutStatus === 'paid') paid += amount;
    else pending += amount;
  }

  const averagePayout = personalPayoutContracts > 0
    ? Math.floor(earned / personalPayoutContracts)
    : 0;
  const payoutProgress = earned > 0
    ? Math.min(100, Math.round((paid / earned) * 100))
    : 100;

  return {
    contracts: rows.length,
    turnover,
    personalPayoutContracts,
    familySupportContracts,
    earned,
    paid,
    pending,
    averagePayout,
    payoutProgress,
  };
}

function familyStats() {
  const rows = getApprovedSubmissions();
  const turnover = rows.reduce((sum, s) => sum + Number(s.amount || 0), 0);
  const credited = rows.reduce((sum, s) => sum + Number(s.familyCredited || 0), 0);
  const participantPayouts = rows.reduce((sum, s) => sum + Number(s.participantPoolCredited || 0), 0);
  const pending = rows.reduce((sum, s) => sum + Number(s.pendingPayoutTotal || 0), 0);
  const paid = rows.reduce((sum, s) => sum + Number(s.paidPayoutTotal || 0), 0);
  const familyOnlyContracts = rows.filter((s) => s.payoutChoice === 'family').length;
  const payoutContracts = rows.filter((s) => s.payoutChoice === 'self').length;
  const averageContract = rows.length > 0 ? Math.floor(turnover / rows.length) : 0;
  const familySharePercent = turnover > 0 ? (credited / turnover) * 100 : 0;
  const payoutTotal = paid + pending;
  const payoutProgress = payoutTotal > 0
    ? Math.min(100, Math.round((paid / payoutTotal) * 100))
    : 100;

  return {
    contracts: rows.length,
    turnover,
    credited,
    participantPayouts,
    pending,
    paid,
    familyOnlyContracts,
    payoutContracts,
    averageContract,
    familySharePercent,
    payoutProgress,
  };
}

function progressBar(percent, size = 10) {
  const safe = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((safe / 100) * size);
  return `${'▰'.repeat(filled)}${'▱'.repeat(size - filled)} ${safe}%`;
}

function isFamilyPayout(choice) {
  return choice === 'family';
}

function isImageAttachment(att) {
  if (!att) return false;
  if (att.contentType && att.contentType.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp)$/i.test(att.name || att.url || '');
}

function screenshotFilename(name) {
  const extMatch = String(name || '').match(/\.(png|jpe?g|gif|webp)$/i);
  let ext = (extMatch ? extMatch[0] : '.png').toLowerCase();
  if (ext === '.jpeg') ext = '.jpg';
  return `screenshot${ext}`;
}

async function downloadBuffer(url, name = 'screenshot.png') {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Не вдалося завантажити зображення (${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const filename = screenshotFilename(name);
  return { buffer, name: filename, attachment: new AttachmentBuilder(buffer, { name: filename }) };
}

async function collectMessageImages(message) {
  const out = [];
  for (const att of message.attachments.values()) {
    if (!isImageAttachment(att)) continue;
    try {
      out.push(await downloadBuffer(att.url, att.name));
    } catch (err) {
      console.warn('Attachment download failed:', err.message);
    }
  }
  if (!out.length) {
    const url = message.embeds[0]?.image?.url;
    if (url) {
      try {
        out.push(await downloadBuffer(url, 'screenshot.png'));
      } catch (err) {
        console.warn('Embed image download failed:', err.message);
      }
    }
  }
  return out;
}

function plainFields(fields) {
  return (fields || [])
    .filter((f) => f && f.name)
    .map((f) => ({
      name: String(f.name).slice(0, 256),
      value: String(f.value || '—').slice(0, 1024),
      inline: Boolean(f.inline),
    }));
}

async function getTextChannel(guild, id) {
  if (!guild || !id) return null;
  try {
    const ch = await guild.channels.fetch(id);
    if (ch && ch.isTextBased()) return ch;
  } catch (err) {
    console.error(`Cannot fetch channel ${id}:`, err.message);
  }
  return null;
}


async function getMediaChannel(guild) {
  if (!guild) return null;

  if (resolvedMediaChannelId) {
    const existingById = await getTextChannel(guild, resolvedMediaChannelId);
    if (existingById) return existingById;
  }

  let channel = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === '🗄️・contract-media',
  );

  if (!channel) {
    const category = guild.channels.cache.find(
      (c) => c.name === '🏠 Kaneko Family' && c.type === ChannelType.GuildCategory,
    );
    const me = guild.members.me;
    channel = await guild.channels.create({
      name: '🗄️・contract-media',
      type: ChannelType.GuildText,
      parent: category?.id,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel],
        },
        ...(me ? [{
          id: me.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.EmbedLinks,
          ],
        }] : []),
      ],
      reason: 'KANEKO bot screenshot storage',
    });
    console.log(`🗄️ Created hidden media channel: ${channel.id}`);
  }

  resolvedMediaChannelId = channel.id;
  return channel;
}

async function storeScreenshot(guild, file, context = '') {
  const mediaChannel = await getMediaChannel(guild);
  if (!mediaChannel) throw new Error('Не вдалося отримати канал зберігання скріншотів');

  const stored = await mediaChannel.send({
    content: `KANEKO contract media${context ? ` • ${context}` : ''}`,
    files: [new AttachmentBuilder(file.buffer, { name: file.name })],
    allowedMentions: { parse: [] },
  });

  const attachment = stored.attachments.first();
  if (!attachment?.url) {
    await stored.delete().catch(() => {});
    throw new Error('Discord не повернув URL збереженого скріншота');
  }

  return {
    url: attachment.url,
    messageId: stored.id,
    channelId: stored.channelId,
  };
}

function canManageMessages(channel, guild) {
  const me = guild?.members?.me;
  if (!me || !channel) return false;
  return channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageMessages) ?? false;
}

function isReviewer(member) {
  if (!member) return false;
  if (!REVIEW_ROLE_ID) return true;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  return member.roles.cache.has(REVIEW_ROLE_ID);
}

function memberMentions(ids) {
  return (ids || []).map((id) => `<@${id}>`).join(', ') || '—';
}

function payoutLabel(choice) {
  return choice === 'self' ? '💰 Отримати особисту виплату' : '🏠 100% на баланс сім\'ї';
}

function clearSession(userId) {
  const state = formState.get(userId);
  if (state?.screenshotTimer) clearTimeout(state.screenshotTimer);
  formState.delete(userId);
}

function scheduleScreenshotTimeout(userId) {
  const state = formState.get(userId);
  if (!state) return;
  if (state.screenshotTimer) clearTimeout(state.screenshotTimer);
  state.screenshotTimer = setTimeout(() => {
    const current = formState.get(userId);
    if (current && current.step === 'screenshot') {
      clearSession(userId);
    }
  }, SCREENSHOT_TIMEOUT_MS);
}

setInterval(() => {
  const now = Date.now();
  for (const [userId, state] of formState) {
    if (now - (state.createdAt || 0) > SESSION_TTL_MS) clearSession(userId);
  }
}, 60 * 1000);

// ─── Register slash commands ──────────────────────────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('контракт')
      .setDescription('Заповнити форму виконаного контракту'),
    new SlashCommandBuilder()
      .setName('скасувати')
      .setDescription('Скасувати незаповнену форму контракту'),
    new SlashCommandBuilder()
      .setName('setup-channels')
      .setDescription('Створити канали для системи контрактів')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName('setup-panel')
      .setDescription('Опублікувати панель запуску контрактів у каналі')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
      .setName('stats')
      .setDescription("Відкрити статистику контрактів KANEKO"),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands },
    );
    console.log('✅ Slash commands registered');
  } catch (err) {
    console.error('❌ Command registration error:', err);
  }
}

// ─── Ready ────────────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`🤖 Bot online: ${client.user.tag}`);
  console.log(`🧩 Build: ${BUILD_VERSION}`);
  try { console.log(`📦 discord.js version: ${require('discord.js').version}`); } catch {}
  await registerCommands();

  for (const [label, id] of [
    ['CHANNEL_CONTRACTS', CHANNEL_CONTRACTS],
    ['CHANNEL_REVIEW', CHANNEL_REVIEW],
    ['CHANNEL_PAYOUTS', CHANNEL_PAYOUTS],
  ]) {
    if (!id) {
      console.warn(`⚠️  ${label} is not set`);
      continue;
    }
    const ch = client.channels.cache.get(id);
    if (!ch) {
      console.warn(`⚠️  ${label}=${id} not in cache yet`);
      continue;
    }
    const me = ch.guild?.members?.me;
    const perms = me ? ch.permissionsFor(me) : null;
    if (perms && !perms.has(PermissionFlagsBits.ManageMessages) && label === 'CHANNEL_CONTRACTS') {
      console.warn('⚠️  Bot lacks Manage Messages in the contracts channel — cannot delete user screenshots. Re-run /setup-channels or grant the permission.');
    }
  }
});

// ─── Message listener — catches screenshot ─────────────────────────
// The user sends one screenshot in #📋・контракти. The bot downloads it,
// deletes the original message and then keeps the image only inside the form/embed.
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const state = formState.get(message.author.id);
  if (!state || state.step !== 'screenshot') return;
  if (CHANNEL_CONTRACTS && message.channelId !== CHANNEL_CONTRACTS) return;

  const image = message.attachments.find(isImageAttachment);
  if (!image) {
    const warn = await message.reply({
      content: '❌ Надішли саме **зображення** (PNG/JPG/WebP), а не посилання або інший файл.',
    }).catch(() => null);
    if (warn) setTimeout(() => warn.delete().catch(() => {}), 8000);
    return;
  }

  try {
    const file = await downloadBuffer(image.url, image.name);
    const stored = await storeScreenshot(message.guild, file, `user ${message.author.id}`);
    state.screenshot = file; // temporary buffer only; visible messages use screenshotUrl
    state.screenshotUrl = stored.url;
    state.screenshotStorageMessageId = stored.messageId;
    state.screenshotStorageChannelId = stored.channelId;
    state.step = 'payout';
    if (state.screenshotTimer) {
      clearTimeout(state.screenshotTimer);
      state.screenshotTimer = null;
    }

    // Remove the raw screenshot message so it is not duplicated in the channel.
    try {
      await message.delete();
    } catch (err) {
      console.warn('Could not delete user screenshot:', err.message);
      const hint = await message.channel.send({
        content: '⚠️ Боту потрібне право **Manage Messages**, щоб прибирати початковий скріншот.',
      }).catch(() => null);
      if (hint) setTimeout(() => hint.delete().catch(() => {}), 10000);
    }

    if (!state.interaction) throw new Error('Не знайдено активну взаємодію форми');
    await showPayoutStep(state.interaction, state);
  } catch (err) {
    console.error('Screenshot handling error:', err);
    await message.channel.send({
      content: `<@${message.author.id}> ❌ Не вдалося обробити скріншот. Спробуй ще раз.`,
      allowedMentions: { users: [message.author.id] },
    }).catch(() => {});
  }
});

// ─── Interaction handler ──────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'контракт')       return await handleStart(interaction);
      if (interaction.commandName === 'скасувати')      return await handleCancel(interaction);
      if (interaction.commandName === 'setup-channels') return await handleSetupChannels(interaction);
      if (interaction.commandName === 'setup-panel')    return await handleSetupPanel(interaction);
      if (interaction.commandName === 'stats')          return await handleStats(interaction);
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'select_contract') return await handleContractSelect(interaction);
      if (interaction.customId.startsWith('select_payout:')) return await handlePayoutSelect(interaction);
    }

    if (interaction.isUserSelectMenu()) {
      if (interaction.customId === 'select_members') return await handleMembersSelect(interaction);
      if (interaction.customId === 'stats_user_select') return await handleStatsUserSelect(interaction);
    }

    if (interaction.isButton()) {
      if (interaction.customId === 'btn_submit_contract' || interaction.customId.startsWith('btn_submit:')) {
        return await handleFinalSubmit(interaction);
      }
      if (interaction.customId === 'btn_new_contract' || interaction.customId === 'btn_panel_start') {
        return await handleStart(interaction);
      }
      if (interaction.customId.startsWith('btn_approve_') || interaction.customId.startsWith('btn_approve:')) {
        return await handleApprove(interaction);
      }
      if (interaction.customId.startsWith('btn_reject_') || interaction.customId.startsWith('btn_reject:')) {
        return await handleReject(interaction);
      }
      if (interaction.customId.startsWith('btn_confirm_payout:')) {
        return await handleConfirmPayout(interaction);
      }
      if (interaction.customId === 'btn_stats_family') {
        return await handleStatsFamilyButton(interaction);
      }
      if (interaction.customId === 'btn_stats_me') {
        return await handleStatsMeButton(interaction);
      }
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith('modal_reject_') || interaction.customId.startsWith('modal_reject:')) {
        return await handleRejectModal(interaction);
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    const msg = { content: '❌ Сталася помилка. Спробуйте ще раз.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
});

function assertOwner(interaction, state) {
  if (!state) {
    return interaction.reply({ content: '❌ Сесія застаріла. Почни знову /контракт', ephemeral: true }).then(() => false);
  }
  if (state.userId !== interaction.user.id) {
    return interaction.reply({ content: '❌ Це чужа форма.', ephemeral: true }).then(() => false);
  }
  return true;
}

// ─── Step 1: Choose contract ──────────────────────────────────────
async function handleStart(interaction) {
  if (CHANNEL_CONTRACTS && interaction.channelId !== CHANNEL_CONTRACTS) {
    const errMsg = { content: `❌ Команду можна використовувати тільки в <#${CHANNEL_CONTRACTS}>`, ephemeral: true };
    return interaction.reply(errMsg);
  }

  clearSession(interaction.user.id);
  formState.set(interaction.user.id, {
    userId: interaction.user.id,
    step: 'contract',
    createdAt: Date.now(),
    interaction,
  });

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('select_contract')
      .setPlaceholder('Обери контракт...')
      .addOptions(CONTRACTS.map((c, i) => ({
        label: `${i + 1}. ${c.name}`,
        description: `Виплата: ${formatMoney(c.amount)}`,
        value: c.id,
      }))),
  );

  const embed = new EmbedBuilder()
    .setTitle('📋 Новий контракт')
    .setDescription('**Крок 1/4** — Обери тип контракту\nНомер заявки буде присвоєно після відправки.')
    .setColor(COLOR.ink)
    .setFooter({ text: 'Kaneko Family' });

  const payload = { content: null, embeds: [embed], components: [row], ephemeral: true };

  // Never overwrite a public receipt / panel — always open a fresh ephemeral form.
  if (interaction.isButton() && interaction.message?.flags?.has(MessageFlags.Ephemeral)) {
    await interaction.update(payload);
  } else if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload);
  } else {
    await interaction.reply(payload);
  }
}

async function handleCancel(interaction) {
  const existed = formState.has(interaction.user.id);
  clearSession(interaction.user.id);
  await interaction.reply({
    content: existed ? '✅ Форму скасовано.' : 'Немає активної форми.',
    ephemeral: true,
  });
}

// ─── Step 2: Choose members ───────────────────────────────────────
async function handleContractSelect(interaction) {
  const state = formState.get(interaction.user.id);
  if (!(await assertOwner(interaction, state))) return;

  const contract = CONTRACTS.find((c) => c.id === interaction.values[0]);
  if (!contract) {
    return interaction.reply({ content: '❌ Невідомий контракт.', ephemeral: true });
  }
  state.contract = contract;
  state.step = 'members';
  state.interaction = interaction;

  const row = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId('select_members')
      .setPlaceholder('Обери учасників контракту...')
      .setMinValues(1)
      .setMaxValues(25),
  );

  const embed = new EmbedBuilder()
    .setTitle('📋 Новий контракт')
    .setDescription(`**Крок 2/4** — Обери учасників\n\n🎯 Контракт: **${contract.name}**\n💵 Сума: **${formatMoney(contract.amount)}**`)
    .setColor(COLOR.ink)
    .setFooter({ text: 'Вибери всіх, хто брав участь (включаючи себе)' });

  await interaction.update({ embeds: [embed], components: [row] });
}

// ─── Step 3: Send screenshot in chat ─────────────────────────────
async function handleMembersSelect(interaction) {
  const state = formState.get(interaction.user.id);
  if (!(await assertOwner(interaction, state))) return;

  const ids = [...interaction.values];
  if (!ids.includes(interaction.user.id)) ids.unshift(interaction.user.id);
  state.members = [...new Set(ids)];
  state.step = 'screenshot';
  state.interaction = interaction;
  scheduleScreenshotTimeout(interaction.user.id);

  const { family, perPerson } = calcPayout(state.contract.amount, state.members.length);

  const embed = new EmbedBuilder()
    .setTitle('📋 Новий контракт')
    .setDescription('**Крок 3/4** — Надішли скріншот виконання\n\n📸 Прикріпи **одне зображення** наступним повідомленням у цей канал. Бот збереже його у формі та одразу видалить початкове повідомлення зі скріном.')
    .addFields(
      { name: '🎯 Контракт', value: state.contract.name, inline: true },
      { name: '💵 Сума', value: formatMoney(state.contract.amount), inline: true },
      { name: '👥 Учасники', value: memberMentions(state.members) },
      { name: "🏠 Сім'ї (20%+)", value: formatMoney(family), inline: true },
      { name: '💰 Кожному учаснику', value: formatMoney(perPerson), inline: true },
    )
    .setColor(COLOR.gold)
    .setFooter({ text: 'Після завантаження скріншота він залишиться тільки у формі' });

  await interaction.update({ embeds: [embed], components: [] });
}

// ─── Step 4: Payout choice (called after image received) ──────────
async function showPayoutStep(interaction, state) {
  const { family, perPerson } = calcPayout(state.contract.amount, state.members.length);

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`select_payout:${state.userId}`)
      .setPlaceholder('Обери варіант виплати...')
      .addOptions([
        { label: '💰 Отримати виплату собі', value: 'self', description: 'Твоя частка буде доступна для виплати' },
        { label: "🏠 Зарахувати всю суму сім'ї", value: 'family', description: "100% суми піде на баланс сім'ї" },
      ]),
  );

  const embed = new EmbedBuilder()
    .setTitle('📋 Новий контракт')
    .setDescription('**Крок 4/4** — Обери варіант виплати')
    .addFields(
      { name: '🎯 Контракт', value: state.contract.name, inline: true },
      { name: '💵 Сума', value: formatMoney(state.contract.amount), inline: true },
      { name: '👥 Учасники', value: memberMentions(state.members) },
      { name: "🏠 Сім'ї (база 20%)", value: formatMoney(family), inline: true },
      { name: '💰 Частка кожного', value: formatMoney(perPerson), inline: true },
    )
    .setColor(COLOR.ink)
    .setFooter({ text: 'Kaneko Family' });

  if (state.screenshotUrl) embed.setImage(state.screenshotUrl);

  // No visible attachment is sent here. The image lives in the hidden media channel,
  // so Discord renders it only once inside the embed.
  await interaction.editReply({ content: null, embeds: [embed], components: [row], attachments: [] });
}

// ─── Step 4 handler: payout selected ─────────────────────────────
async function handlePayoutSelect(interaction) {
  const ownerId = interaction.customId.split(':')[1];
  if (ownerId && ownerId !== interaction.user.id) {
    return interaction.reply({ content: '❌ Це чужа форма.', ephemeral: true });
  }

  const state = formState.get(interaction.user.id);
  if (!(await assertOwner(interaction, state))) return;

  state.payoutChoice = interaction.values[0];

  const { family, perPerson } = calcPayout(state.contract.amount, state.members.length);
  const displayFamily = state.payoutChoice === 'family' ? state.contract.amount : family;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`btn_submit:${state.userId}`)
      .setLabel('✅ Відправити заявку')
      .setStyle(ButtonStyle.Success),
  );

  const embed = new EmbedBuilder()
    .setTitle('📋 Підтвердження контракту')
    .setDescription('Перевір дані та відправ заявку. Номер буде присвоєно після відправки.')
    .addFields(
      { name: '🎯 Контракт',         value: state.contract.name,                inline: true },
      { name: '💵 Загальна сума',    value: formatMoney(state.contract.amount), inline: true },
      { name: '👥 Учасники',         value: memberMentions(state.members) },
      { name: '🏠 Сім\'ї',     value: formatMoney(displayFamily),                inline: true },
      { name: '💰 Кожному учаснику', value: state.payoutChoice === 'family' ? '$0' : formatMoney(perPerson),             inline: true },
      { name: '📤 Ваш вибір',        value: payoutLabel(state.payoutChoice) },
    )
    .setColor(COLOR.gold)
    .setFooter({ text: 'Kaneko Family' });

  if (state.screenshotUrl) embed.setImage(state.screenshotUrl);

  await interaction.update({ embeds: [embed], components: [row], attachments: [] });
}

// ─── Final submit ─────────────────────────────────────────────────
async function handleFinalSubmit(interaction) {
  const ownerId = interaction.customId.includes(':') ? interaction.customId.split(':')[1] : null;
  if (ownerId && ownerId !== interaction.user.id) {
    return interaction.reply({ content: '❌ Це чужа форма.', ephemeral: true });
  }

  const state = formState.get(interaction.user.id);
  if (!(await assertOwner(interaction, state))) return;
  if (!state.contract || !state.members?.length || !state.payoutChoice) {
    return interaction.reply({ content: '❌ Форма незаповнена. Почни знову /контракт', ephemeral: true });
  }

  await interaction.deferUpdate();

  const number = await allocateNumber();
  const code = formatCode(number);
  const { family, perPerson } = calcPayout(state.contract.amount, state.members.length);
  const displayFamily = state.payoutChoice === 'family' ? state.contract.amount : family;
  const displayPerPerson = state.payoutChoice === 'family' ? 0 : perPerson;
  const submittedAt = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

  const reviewEmbed = new EmbedBuilder()
    .setTitle(`📑 ${code} · На перевірку`)
    .setDescription(`Подав: <@${interaction.user.id}>`)
    .addFields(
      { name: '🔢 Номер',            value: `\`${code}\``,                      inline: true },
      { name: '🎯 Контракт',         value: state.contract.name,                inline: true },
      { name: '💵 Загальна сума',    value: formatMoney(state.contract.amount), inline: true },
      { name: '👥 Учасники',         value: memberMentions(state.members) },
      { name: '🏠 Сім\'ї',     value: formatMoney(displayFamily),                inline: true },
      { name: '💰 Кожному учаснику', value: formatMoney(displayPerPerson),             inline: true },
      { name: '📤 Вибір виплати',    value: payoutLabel(state.payoutChoice) },
      { name: '🕐 Час подання',      value: submittedAt },
    )
    .setColor(COLOR.gold)
    .setFooter({ text: `Kaneko Family • ${code} • ${interaction.user.id}` });

  if (state.screenshotUrl) reviewEmbed.setImage(state.screenshotUrl);

  const approveRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`btn_approve:${number}`)
      .setLabel('✅ Підтвердити')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`btn_reject:${number}`)
      .setLabel('❌ Відхилити')
      .setStyle(ButtonStyle.Danger),
  );

  const reviewChannel = await getTextChannel(interaction.guild, CHANNEL_REVIEW);
  if (!reviewChannel) {
    await interaction.followUp({
      content: '❌ Канал перевірки не знайдено. Перевір `CHANNEL_REVIEW` і права бота.',
      ephemeral: true,
    });
    return;
  }

  try {
    await reviewChannel.send({
      embeds: [reviewEmbed],
      components: [approveRow],
    });
  } catch (err) {
    console.error('Review send error:', err);
    await interaction.followUp({
      content: `❌ Не вдалося відправити на перевірку: ${err.message}`,
      ephemeral: true,
    });
    return;
  }

  await saveSubmission({
    number,
    code,
    contractId: state.contract.id,
    contractName: state.contract.name,
    amount: state.contract.amount,
    members: state.members,
    payoutChoice: state.payoutChoice,
    submitterId: interaction.user.id,
    status: 'pending',
    submittedAt: new Date().toISOString(),
    reviewerId: null,
    rejectReason: null,
    screenshotUrl: state.screenshotUrl || null,
    screenshotStorageMessageId: state.screenshotStorageMessageId || null,
    screenshotStorageChannelId: state.screenshotStorageChannelId || null,
    payoutStatus: state.payoutChoice === 'family' ? 'family' : 'pending',
    familyCredited: 0,
    participantPoolCredited: 0,
    pendingPayoutTotal: 0,
    paidPayoutTotal: 0,
  });

  const confirmEmbed = new EmbedBuilder()
    .setTitle(`✅ ${code} · Заявку відправлено`)
    .setDescription('Контракт відправлено на перевірку. Після підтвердження виплата з\'явиться у відповідному каналі.\n\nФорма залишається в каналі як квитанція.')
    .addFields(
      { name: '🔢 Номер',    value: `\`${code}\``,                      inline: true },
      { name: '🎯 Контракт', value: state.contract.name,                inline: true },
      { name: '💵 Сума',     value: formatMoney(state.contract.amount), inline: true },
    )
    .setColor(COLOR.ok)
    .setFooter({ text: `Kaneko Family • ${code}` });

  if (state.screenshotUrl) confirmEmbed.setImage(state.screenshotUrl);

  const newContractRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_new_contract')
      .setLabel('📋 Новий контракт')
      .setStyle(ButtonStyle.Primary),
  );


  // Keep the bot form in chat — edit it into a numbered receipt. Do NOT delete it.
  await interaction.editReply({
    content: null,
    embeds: [confirmEmbed],
    components: [newContractRow],
    attachments: [],
  });

  clearSession(interaction.user.id);
}

// ─── Approve ──────────────────────────────────────────────────────
async function handleApprove(interaction) {
  if (!isReviewer(interaction.member)) {
    return interaction.reply({ content: '❌ Немає права затверджувати контракти.', ephemeral: true });
  }

  if (inFlight.has(interaction.message.id)) {
    return interaction.reply({ content: '⏳ Ця заявка вже обробляється.', ephemeral: true });
  }
  inFlight.add(interaction.message.id);

  try {
    await interaction.deferUpdate();
    const originalEmbed = interaction.message.embeds[0];
    if (!originalEmbed) throw new Error('У повідомленні немає ембеда');

    const number = parseCodeFromFooter(originalEmbed.footer?.text)
      || Number(String(interaction.customId).split(/[:_]/).pop());
    const submission = getSubmissionByNumber(number);
    if (!submission || submission.status !== 'pending') {
      throw new Error('Заявку не знайдено або її вже оброблено.');
    }

    const screenshotUrl = submission.screenshotUrl || originalEmbed.image?.url || null;
    const familyMode = isFamilyPayout(submission.payoutChoice);
    const { family, perPerson, participantPool } = calcPayout(submission.amount, submission.members.length);
    const familyCredited = familyMode ? Number(submission.amount) : family;
    const pendingPayoutTotal = familyMode ? 0 : perPerson * submission.members.length;

    const payoutFields = plainFields(originalEmbed.fields)
      .filter((f) => f.name !== '🕐 Час подання')
      .concat([
        { name: '🕐 Затверджено', value: new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' }), inline: false },
        { name: "🏦 До балансу сім'ї", value: formatMoney(familyCredited), inline: true },
        { name: '💳 Статус виплати', value: familyMode ? "🏠 Зараховано повністю сім'ї" : '🟡 Очікує фактичної виплати', inline: true },
      ]);

    const approvedEmbed = new EmbedBuilder()
      .setTitle(`💰 ${submission.code} · Виплата затверджена`)
      .setDescription(`✅ Перевірив: <@${interaction.user.id}>`)
      .addFields(payoutFields)
      .setColor(COLOR.ok)
      .setFooter({ text: `Kaneko Family • ${submission.code}` });
    if (screenshotUrl) approvedEmbed.setImage(screenshotUrl);

    const payoutsChannel = await getTextChannel(interaction.guild, CHANNEL_PAYOUTS);
    if (!payoutsChannel) throw new Error('Канал виплат не знайдено. Перевір CHANNEL_PAYOUTS.');

    const payoutComponents = [];
    if (!familyMode) {
      payoutComponents.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`btn_confirm_payout:${number}`)
          .setLabel('💵 Підтвердити виплату')
          .setStyle(ButtonStyle.Success),
      ));
    }

    await payoutsChannel.send({
      embeds: [approvedEmbed],
      components: payoutComponents,
    });

    await updateSubmission(number, {
      status: 'approved',
      reviewerId: interaction.user.id,
      reviewedAt: new Date().toISOString(),
      familyCredited,
      participantPoolCredited: familyMode ? 0 : participantPool,
      pendingPayoutTotal,
      paidPayoutTotal: 0,
      payoutStatus: familyMode ? 'family' : 'pending',
      payoutApprovedAt: new Date().toISOString(),
      perPerson,
    });

    const updatedEmbed = new EmbedBuilder()
      .setTitle(`📑 ${submission.code} · ЗАТВЕРДЖЕНО`)
      .setDescription(`${originalEmbed.description ?? ''}

✅ Затверджено: <@${interaction.user.id}>`)
      .addFields(plainFields(originalEmbed.fields))
      .setColor(COLOR.ok)
      .setFooter({ text: originalEmbed.footer?.text ?? `Kaneko Family • ${submission.code}` });
    if (screenshotUrl) updatedEmbed.setImage(screenshotUrl);

    await interaction.message.edit({ embeds: [updatedEmbed], components: [], attachments: [] });
  } catch (err) {
    console.error('Approve error:', err);
    const msg = { content: `❌ Не вдалося затвердити: ${err.message}`, ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  } finally {
    inFlight.delete(interaction.message.id);
  }
}

// ─── Confirm actual payout ─────────────────────────────────────────
async function handleConfirmPayout(interaction) {
  if (!isReviewer(interaction.member)) {
    return interaction.reply({ content: '❌ Тільки Director або Overseer можуть підтвердити виплату.', ephemeral: true });
  }

  const number = Number(String(interaction.customId).split(':').pop());
  const submission = getSubmissionByNumber(number);
  if (!submission || submission.status !== 'approved') {
    return interaction.reply({ content: '❌ Контракт не знайдено або він не затверджений.', ephemeral: true });
  }
  if (submission.payoutChoice !== 'self') {
    return interaction.reply({ content: "ℹ️ Для цього контракту виплата йде повністю на баланс сім'ї.", ephemeral: true });
  }
  if (submission.payoutStatus === 'paid') {
    return interaction.reply({ content: '⚠️ Цю виплату вже підтверджено.', ephemeral: true });
  }

  const now = new Date().toISOString();
  await updateSubmission(number, {
    payoutStatus: 'paid',
    paidPayoutTotal: Number(submission.pendingPayoutTotal || 0),
    pendingPayoutTotal: 0,
    payoutPaidAt: now,
    payoutPaidBy: interaction.user.id,
  });

  const originalEmbed = interaction.message.embeds[0];
  const paidAtLabel = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
  const updatedFields = plainFields(originalEmbed.fields).map((field) => {
    if (field.name === '💳 Статус виплати') {
      return { ...field, value: '🟢 Виплачено' };
    }
    return field;
  });

  // Backward compatibility for payout cards created before this fix.
  if (!updatedFields.some((f) => f.name === '💳 Статус виплати')) {
    updatedFields.push({ name: '💳 Статус виплати', value: '🟢 Виплачено', inline: true });
  }
  updatedFields.push({ name: '🕐 Фактична виплата', value: paidAtLabel, inline: false });

  const embed = EmbedBuilder.from(originalEmbed)
    .setTitle(`💵 ${submission.code} · ВИПЛАТУ ПІДТВЕРДЖЕНО`)
    .setColor(COLOR.ok)
    .setFields(updatedFields)
    .setDescription(`${originalEmbed.description ?? ''}

🟢 Кошти фактично передано учасникам.
👤 Підтвердив: <@${interaction.user.id}>`);

  await interaction.update({ embeds: [embed], components: [], attachments: [] });
}

// ─── Reject ───────────────────────────────────────────────────────
async function handleReject(interaction) {
  if (!isReviewer(interaction.member)) {
    return interaction.reply({ content: '❌ Немає права відхиляти контракти.', ephemeral: true });
  }

  const token = interaction.customId.replace(/^btn_reject[:_]/, '');

  const modal = new ModalBuilder()
    .setCustomId(`modal_reject:${token}`)
    .setTitle('Причина відхилення');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('reject_reason')
        .setLabel('Вкажи причину відхилення')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(500),
    ),
  );

  await interaction.showModal(modal);
}

async function handleRejectModal(interaction) {
  await interaction.deferUpdate();

  try {
    const token = interaction.customId.replace(/^modal_reject[:_]/, '');
    const reason = interaction.fields.getTextInputValue('reject_reason');
    const originalEmbed = interaction.message.embeds[0];
    if (!originalEmbed) throw new Error('У повідомленні немає ембеда');

    const number = parseCodeFromFooter(originalEmbed.footer?.text) || Number(token);
    const code = Number.isFinite(number) && number > 0 ? formatCode(number) : 'K-???';

    const rejectedEmbed = new EmbedBuilder()
      .setTitle(`📑 ${code} · ВІДХИЛЕНО`)
      .setDescription(`${originalEmbed.description ?? ''}\n\n❌ Відхилив: <@${interaction.user.id}>\n📝 Причина: ${reason}`)
      .addFields(plainFields(originalEmbed.fields))
      .setColor(COLOR.bad)
      .setFooter({ text: originalEmbed.footer?.text ?? `Kaneko Family • ${code}` });

    if (originalEmbed.image?.url) rejectedEmbed.setImage(originalEmbed.image.url);

    await interaction.message.edit({ embeds: [rejectedEmbed], components: [], attachments: [] });

    if (Number.isFinite(number) && number > 0) {
      await updateSubmission(number, {
        status: 'rejected',
        reviewerId: interaction.user.id,
        rejectReason: reason,
        reviewedAt: new Date().toISOString(),
      });
    }

    const submitterId = (originalEmbed.footer?.text || '').split('•').pop()?.trim();
    if (submitterId && /^\d+$/.test(submitterId)) {
      try {
        const submitter = await interaction.guild.members.fetch(submitterId);
        await submitter.send({
          embeds: [new EmbedBuilder()
            .setTitle(`❌ ${code} відхилено`)
            .setDescription(`**Причина:** ${reason}`)
            .setColor(COLOR.bad)
            .setFooter({ text: 'Kaneko Family' })],
        });
      } catch { /* DMs closed */ }
    }
  } catch (err) {
    console.error('Reject modal error:', err);
    await interaction.followUp({
      content: `❌ Не вдалося відхилити: ${err.message}`,
      ephemeral: true,
    }).catch(() => {});
  }
}

// ─── Statistics ────────────────────────────────────────────────────
function statsControls() {
  const userRow = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId('stats_user_select')
      .setPlaceholder('👤 Переглянути статистику гравця...')
      .setMinValues(1)
      .setMaxValues(1),
  );

  const navRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_stats_family')
      .setLabel("Статистика сім'ї")
      .setEmoji('🏠')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('btn_stats_me')
      .setLabel('Моя статистика')
      .setEmoji('👤')
      .setStyle(ButtonStyle.Secondary),
  );

  return [userRow, navRow];
}

function buildFamilyStatsEmbed() {
  const s = familyStats();

  return new EmbedBuilder()
    .setTitle('📊 KANEKO · Статистика контрактів')
    .setDescription(
      `Зведення по **схвалених контрактах** сім'ї.\n` +
      `Баланс формується з частки сім'ї та контрактів, повністю переданих у фонд.`
    )
    .addFields(
      {
        name: '🚚 Контракти',
        value:
          `**${s.contracts}** схвалено\n` +
          `Середня вартість: **${formatMoney(s.averageContract)}**`,
        inline: true,
      },
      {
        name: '💵 Загальний оборот',
        value: `**${formatMoney(s.turnover)}**`,
        inline: true,
      },
      {
        name: "🏦 Баланс сім'ї",
        value:
          `**${formatMoney(s.credited)}**\n` +
          `${s.familySharePercent.toFixed(1)}% від обороту`,
        inline: true,
      },
      {
        name: '👥 Розподіл контрактів',
        value:
          `💰 З виплатою учасникам: **${s.payoutContracts}**\n` +
          `🏠 100% у фонд сім'ї: **${s.familyOnlyContracts}**`,
        inline: false,
      },
      {
        name: '💸 Нараховано учасникам',
        value: `**${formatMoney(s.participantPayouts)}**`,
        inline: true,
      },
      {
        name: '✅ Фактично виплачено',
        value: `**${formatMoney(s.paid)}**`,
        inline: true,
      },
      {
        name: '⏳ Очікує виплати',
        value: `**${formatMoney(s.pending)}**`,
        inline: true,
      },
      {
        name: '📈 Виконання виплат',
        value: progressBar(s.payoutProgress),
        inline: false,
      },
    )
    .setColor(COLOR.gold)
    .setFooter({ text: 'KANEKO Family • Обери гравця нижче для персональної статистики' })
    .setTimestamp();
}

async function buildPlayerStatsEmbed(guild, user) {
  const s = playerStats(user.id);
  const member = await guild.members.fetch(user.id).catch(() => null);
  const nickname = member?.displayName || user.globalName || user.username;

  return new EmbedBuilder()
    .setTitle(`👤 ${nickname} · Статистика контрактів`)
    .setDescription(`<@${user.id}> • персональне зведення по схвалених контрактах`)
    .setThumbnail(user.displayAvatarURL({ size: 128 }))
    .addFields(
      {
        name: '🚚 Участь у контрактах',
        value:
          `Всього: **${s.contracts}**\n` +
          `З особистою виплатою: **${s.personalPayoutContracts}**\n` +
          `На користь сім'ї: **${s.familySupportContracts}**`,
        inline: true,
      },
      {
        name: '📦 Оборот контрактів',
        value: `**${formatMoney(s.turnover)}**`,
        inline: true,
      },
      {
        name: '💰 Особисто нараховано',
        value:
          `**${formatMoney(s.earned)}**\n` +
          `Середня виплата: **${formatMoney(s.averagePayout)}**`,
        inline: true,
      },
      {
        name: '✅ Виплачено',
        value: `**${formatMoney(s.paid)}**`,
        inline: true,
      },
      {
        name: '⏳ Очікує виплати',
        value: `**${formatMoney(s.pending)}**`,
        inline: true,
      },
      {
        name: '📈 Отримано від нарахованого',
        value: progressBar(s.payoutProgress),
        inline: false,
      },
    )
    .setColor(COLOR.gold)
    .setFooter({ text: "KANEKO Family • Натисни «Статистика сім'ї», щоб повернутися" })
    .setTimestamp();
}

async function handleStats(interaction) {
  return interaction.reply({
    embeds: [buildFamilyStatsEmbed()],
    components: statsControls(),
    ephemeral: true,
  });
}

async function handleStatsUserSelect(interaction) {
  const user = interaction.users.first();
  if (!user) {
    return interaction.reply({ content: '❌ Не вдалося визначити гравця.', ephemeral: true });
  }

  const embed = await buildPlayerStatsEmbed(interaction.guild, user);
  return interaction.update({
    embeds: [embed],
    components: statsControls(),
  });
}

async function handleStatsFamilyButton(interaction) {
  return interaction.update({
    embeds: [buildFamilyStatsEmbed()],
    components: statsControls(),
  });
}

async function handleStatsMeButton(interaction) {
  const embed = await buildPlayerStatsEmbed(interaction.guild, interaction.user);
  return interaction.update({
    embeds: [embed],
    components: statsControls(),
  });
}

// ─── Setup channels ───────────────────────────────────────────────
async function handleSetupChannels(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const guild = interaction.guild;
  const me = guild.members.me;

  let category = guild.channels.cache.find(
    (c) => c.name === '🏠 Kaneko Family' && c.type === ChannelType.GuildCategory,
  );
  if (!category) {
    category = await guild.channels.create({ name: '🏠 Kaneko Family', type: ChannelType.GuildCategory });
  }

  const botAllow = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.UseApplicationCommands,
  ];

  const channelDefs = [
    { key: 'CHANNEL_CONTRACTS', name: '📋・контракти' },
    { key: 'CHANNEL_REVIEW',    name: '📑・перевірка-контрактів' },
    { key: 'CHANNEL_PAYOUTS',   name: '💰・виплати' },
  ];

  const created = [];
  const ids = {};
  for (const ch of channelDefs) {
    let channel = guild.channels.cache.find((c) => c.name === ch.name);
    if (!channel) {
      channel = await guild.channels.create({
        name: ch.name,
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: me ? [{ id: me.id, allow: botAllow }] : [],
      });
      created.push(`<#${channel.id}> — створено (\`${channel.id}\`)`);
    } else {
      if (me) {
        await channel.permissionOverwrites.edit(me.id, {
          ViewChannel: true,
          SendMessages: true,
          ManageMessages: true,
          EmbedLinks: true,
          AttachFiles: true,
          ReadMessageHistory: true,
          UseApplicationCommands: true,
        }).catch(() => {});
      }
      created.push(`<#${channel.id}> — вже існує (\`${channel.id}\`)`);
    }
    ids[ch.key] = channel.id;
  }

  const mediaChannel = await getMediaChannel(guild);
  if (mediaChannel) {
    created.push(`<#${mediaChannel.id}> — приховане сховище скріншотів (\`${mediaChannel.id}\`)`);
  }

  await interaction.editReply({
    content: `✅ **Канали готові!**\n\n${created.join('\n')}\n\n📌 Скопіюй ID у змінні середовища:\n\`\`\`\nCHANNEL_CONTRACTS=${ids.CHANNEL_CONTRACTS}\nCHANNEL_REVIEW=${ids.CHANNEL_REVIEW}\nCHANNEL_PAYOUTS=${ids.CHANNEL_PAYOUTS}\nCHANNEL_MEDIA=${mediaChannel?.id || ''}\n\`\`\`\n\nБот отримав право **Manage Messages**, щоб видаляти скріни з чату.`,
  });
}

async function handleSetupPanel(interaction) {
  if (CHANNEL_CONTRACTS && interaction.channelId !== CHANNEL_CONTRACTS) {
    return interaction.reply({
      content: `❌ Панель публікується тільки в <#${CHANNEL_CONTRACTS}>`,
      ephemeral: true,
    });
  }

  const data = loadData();
  const next = formatCode(data.nextNumber);

  const embed = new EmbedBuilder()
    .setTitle('Kaneko Family · Контракти')
    .setDescription('Натисни кнопку, щоб подати виконаний контракт.\nСкріншот з чату забере бот, форма залишиться як квитанція з номером.')
    .addFields(
      { name: 'Наступний номер', value: `\`${next}\``, inline: true },
      { name: 'Типів контрактів', value: String(CONTRACTS.length), inline: true },
    )
    .setColor(COLOR.gold)
    .setFooter({ text: 'Kaneko Family' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_panel_start')
      .setLabel('Заповнити контракт')
      .setStyle(ButtonStyle.Primary),
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}

client.on('error', (err) => console.error('Client error:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

// ─── Render health server ─────────────────────────────────────────
// Render Web Services require an open HTTP port. Discord itself does not,
// so this tiny health endpoint only keeps a Render Web Service healthy.
// If you deploy as a Background Worker, PORT is normally absent and this is skipped.
const RENDER_PORT = Number(process.env.PORT || 0);
if (RENDER_PORT > 0) {
  const healthServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Kaneko Discord bot is running (${BUILD_VERSION})`);
  });

  healthServer.listen(RENDER_PORT, '0.0.0.0', () => {
    console.log(`🌐 Health server listening on port ${RENDER_PORT}`);
  });
}

client.login(process.env.DISCORD_TOKEN);
