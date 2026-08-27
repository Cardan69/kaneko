const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, UserSelectMenuBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, EmbedBuilder, AttachmentBuilder,
  PermissionFlagsBits, ChannelType, Events, MessageFlags,
} = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

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
  { id: 'balloon2', name: 'Балонний транзит ІІ',    amount: 185000 },
  { id: 'root2',    name: 'Під корінь ІІ',          amount: 175000 },
];

function env(name) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : null;
}

const CHANNEL_CONTRACTS = env('CHANNEL_CONTRACTS');
const CHANNEL_REVIEW    = env('CHANNEL_REVIEW');
const CHANNEL_PAYOUTS   = env('CHANNEL_PAYOUTS');
const REVIEW_ROLE_ID    = env('REVIEW_ROLE_ID');

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

// ─── Persistent store ─────────────────────────────────────────────
function defaultData() {
  return { nextNumber: 1, submissions: [] };
}

function loadData() {
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    if (!raw || typeof raw !== 'object') return defaultData();
    return {
      nextNumber: Number(raw.nextNumber) > 0 ? Number(raw.nextNumber) : 1,
      submissions: Array.isArray(raw.submissions) ? raw.submissions : [],
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
  const family    = Math.round(amount * 0.20);
  const perPerson = Math.round((amount - family) / safeCount);
  return { family, perPerson };
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
  return choice === 'self' ? '💰 Отримати виплату собі' : '🏠 Віддати виплату сім\'ї';
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
client.once('ready', async () => {
  console.log(`🤖 Bot online: ${client.user.tag}`);
  await registerCommands();
});

// ─── Message listener — catches screenshot ────────────────────────
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const state = formState.get(message.author.id);
  if (!state || state.step !== 'screenshot') return;
  if (CHANNEL_CONTRACTS && message.channelId !== CHANNEL_CONTRACTS) return;

  const image = message.attachments.find(isImageAttachment);
  if (!image) {
    const warn = await message.reply({
      content: '❌ Надішли саме **зображення** (не файл, не посилання). Спробуй ще раз.',
    }).catch(() => null);
    if (warn) setTimeout(() => warn.delete().catch(() => {}), 8000);
    return;
  }

  try {
    const file = await downloadBuffer(image.url, image.name);
    state.screenshot = file;
    state.step = 'payout';
    if (state.screenshotTimer) {
      clearTimeout(state.screenshotTimer);
      state.screenshotTimer = null;
    }

    try {
      await message.delete();
    } catch (err) {
      console.warn('Could not delete user screenshot:', err.message);
    }

    if (state.interaction) {
      await state.interaction.editReply({
        content: '✅ Скріншот отримано. Продовжи форму нижче.',
        embeds: [],
        components: [],
      }).catch(() => {});
    }

    await showPayoutStep(message.channel, state);
  } catch (err) {
    console.error('Screenshot handling error:', err);
    await message.reply({ content: '❌ Не вдалося обробити скріншот. Надішли зображення ще раз.' }).catch(() => {});
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
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'select_contract') return await handleContractSelect(interaction);
      if (interaction.customId.startsWith('select_payout:')) return await handlePayoutSelect(interaction);
    }

    if (interaction.isUserSelectMenu() && interaction.customId === 'select_members') {
      return await handleMembersSelect(interaction);
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
      if (interaction.customId.startsWith('btn_paid_') || interaction.customId.startsWith('btn_paid:')) {
        return await handlePaid(interaction);
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
      .setMaxValues(4),
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
  if (!ids.includes(interaction.user.id) && ids.length < 4) {
    ids.unshift(interaction.user.id);
  }
  state.members = ids;
  state.step = 'screenshot';
  state.interaction = interaction;
  scheduleScreenshotTimeout(interaction.user.id);

  const { family, perPerson } = calcPayout(state.contract.amount, state.members.length);

  const embed = new EmbedBuilder()
    .setTitle('📋 Новий контракт')
    .setDescription('**Крок 3/4** — Надішли скріншот виконання\n\n📸 **Надішли фото прямо в цей канал** наступним повідомленням.\nБот забере скрін з чату і залишить форму.')
    .addFields(
      { name: '🎯 Контракт',         value: state.contract.name,                inline: true },
      { name: '💵 Сума',             value: formatMoney(state.contract.amount), inline: true },
      { name: '👥 Учасники',         value: memberMentions(state.members) },
      { name: '🏠 Сім\'ї (20%)',     value: formatMoney(family),                inline: true },
      { name: '💰 Кожному учаснику', value: formatMoney(perPerson),             inline: true },
    )
    .setColor(COLOR.gold)
    .setFooter({ text: 'Просто прикріпи фото і надішли — бот його підхопить автоматично' });

  await interaction.update({ embeds: [embed], components: [] });
}

// ─── Step 4: Payout choice ────────────────────────────────────────
async function showPayoutStep(channel, state) {
  const { family, perPerson } = calcPayout(state.contract.amount, state.members.length);

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`select_payout:${state.userId}`)
      .setPlaceholder('Обери варіант виплати...')
      .addOptions([
        { label: '💰 Отримати виплату собі',  value: 'self',   description: 'Твоя частка зараховується тобі' },
        { label: '🏠 Віддати виплату сім\'ї', value: 'family', description: 'Твоя частка йде у фонд сім\'ї' },
      ]),
  );

  const embed = new EmbedBuilder()
    .setTitle('📋 Новий контракт')
    .setDescription('**Крок 4/4** — Обери варіант виплати')
    .addFields(
      { name: '🎯 Контракт',     value: state.contract.name,                inline: true },
      { name: '💵 Сума',         value: formatMoney(state.contract.amount), inline: true },
      { name: '👥 Учасники',     value: memberMentions(state.members) },
      { name: '🏠 Сім\'ї (20%)', value: formatMoney(family),                inline: true },
      { name: '💰 Твоя частка',  value: formatMoney(perPerson),             inline: true },
    )
    .setColor(COLOR.ink)
    .setFooter({ text: 'Kaneko Family' });

  const files = [];
  if (state.screenshot) {
    embed.setImage(`attachment://${state.screenshot.name}`);
    files.push(new AttachmentBuilder(state.screenshot.buffer, { name: state.screenshot.name }));
  }

  const sent = await channel.send({
    content: `<@${state.userId}>`,
    embeds: [embed],
    files,
    components: [row],
    allowedMentions: { users: [state.userId] },
  });

  state.payoutMessageId = sent.id;
  state.payoutChannelId = sent.channelId;
}

async function handlePayoutSelect(interaction) {
  const ownerId = interaction.customId.split(':')[1];
  if (ownerId && ownerId !== interaction.user.id) {
    return interaction.reply({ content: '❌ Це чужа форма.', ephemeral: true });
  }

  const state = formState.get(interaction.user.id);
  if (!(await assertOwner(interaction, state))) return;

  state.payoutChoice = interaction.values[0];

  const { family, perPerson } = calcPayout(state.contract.amount, state.members.length);

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
      { name: '🏠 Сім\'ї (20%)',     value: formatMoney(family),                inline: true },
      { name: '💰 Кожному учаснику', value: formatMoney(perPerson),             inline: true },
      { name: '📤 Ваш вибір',        value: payoutLabel(state.payoutChoice) },
    )
    .setColor(COLOR.gold)
    .setFooter({ text: 'Kaneko Family' });

  const files = [];
  if (state.screenshot) {
    embed.setImage(`attachment://${state.screenshot.name}`);
    files.push(new AttachmentBuilder(state.screenshot.buffer, { name: state.screenshot.name }));
  }

  // attachments: [] запобігає дублюванню зображень під час оновлення повідомлення
  await interaction.update({ embeds: [embed], components: [row], files, attachments: [] });
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
  const submittedAt = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

  const reviewFiles = [];
  const reviewEmbed = new EmbedBuilder()
    .setTitle(`📑 ${code} · На перевірку`)
    .setDescription(`Подав: <@${interaction.user.id}>`)
    .addFields(
      { name: '🔢 Номер',            value: `\`${code}\``,                      inline: true },
      { name: '🎯 Контракт',         value: state.contract.name,                inline: true },
      { name: '💵 Загальна сума',    value: formatMoney(state.contract.amount), inline: true },
      { name: '👥 Учасники',         value: memberMentions(state.members) },
      { name: '🏠 Сім\'ї (20%)',     value: formatMoney(family),                inline: true },
      { name: '💰 Кожному учаснику', value: formatMoney(perPerson),             inline: true },
      { name: '📤 Вибір виплати',    value: payoutLabel(state.payoutChoice) },
      { name: '🕐 Час подання',      value: submittedAt },
    )
    .setColor(COLOR.gold)
    .setFooter({ text: `Kaneko Family • ${code} • ${interaction.user.id}` });

  if (state.screenshot) {
    reviewEmbed.setImage(`attachment://${state.screenshot.name}`);
    reviewFiles.push(new AttachmentBuilder(state.screenshot.buffer, { name: state.screenshot.name }));
  }

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
      files: reviewFiles,
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

  const confirmFiles = [];
  if (state.screenshot) {
    confirmEmbed.setImage(`attachment://${state.screenshot.name}`);
    confirmFiles.push(new AttachmentBuilder(state.screenshot.buffer, { name: state.screenshot.name }));
  }

  const newContractRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_new_contract')
      .setLabel('📋 Новий контракт')
      .setStyle(ButtonStyle.Primary),
  );

  // attachments: [] запобігає дублюванню зображень під час оновлення повідомлення
  await interaction.editReply({
    content: null,
    embeds: [confirmEmbed],
    components: [newContractRow],
    files: confirmFiles,
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
    const code = Number.isFinite(number) && number > 0 ? formatCode(number) : 'K-???';

    const imageFiles = await collectMessageImages(interaction.message);

    const payoutFields = plainFields(originalEmbed.fields)
      .filter((f) => f.name !== '🕐 Час подання');

    const pendingPayoutEmbed = new EmbedBuilder()
      .setTitle(`⏳ ${code} · Очікує виплати`)
      .setDescription(`✅ Перевірив: <@${interaction.user.id}>\nОчікує видачі коштів керівником.`)
      .addFields(payoutFields)
      .setColor(COLOR.gold)
      .setFooter({ text: `Kaneko Family • ${code}` });

    const filesToSend = [];
    if (imageFiles[0]) {
      pendingPayoutEmbed.setImage(`attachment://${imageFiles[0].name}`);
      filesToSend.push(imageFiles[0].attachment);
    }

    const payoutRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`btn_paid:${number}`)
        .setLabel('💸 Підтвердити виплату')
        .setStyle(ButtonStyle.Success)
    );

    const payoutsChannel = await getTextChannel(interaction.guild, CHANNEL_PAYOUTS);
    if (!payoutsChannel) {
      await interaction.followUp({
        content: '❌ Канал виплат не знайдено. Перевір `CHANNEL_PAYOUTS`.',
        ephemeral: true,
      });
      return;
    }

    await payoutsChannel.send({
      embeds: [pendingPayoutEmbed],
      files: filesToSend,
      components: [payoutRow],
    });

    const updatedEmbed = new EmbedBuilder()
      .setTitle(`📑 ${code} · ЗАТВЕРДЖЕНО`)
      .setDescription(`${originalEmbed.description ?? ''}\n\n✅ Затверджено: <@${interaction.user.id}>`)
      .addFields(plainFields(originalEmbed.fields))
      .setColor(COLOR.ok)
      .setFooter({ text: originalEmbed.footer?.text ?? `Kaneko Family • ${code}` });

    // Прибираємо скріншот із каналу перевірок
    await interaction.message.edit({ embeds: [updatedEmbed], components: [], attachments: [] });

    if (Number.isFinite(number) && number > 0) {
      await updateSubmission(number, {
        status: 'approved',
        reviewerId: interaction.user.id,
        reviewedAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error('Approve error:', err);
    const msg = { content: `❌ Не вдалося затвердити: ${err.message}`, ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  } finally {
    inFlight.delete(interaction.message.id);
  }
}

// ─── Payout Confirmation ──────────────────────────────────────────
async function handlePaid(interaction) {
  if (!isReviewer(interaction.member)) {
    return interaction.reply({ content: '❌ Немає права підтверджувати виплати.', ephemeral: true });
  }

  try {
    await interaction.deferUpdate();

    const originalEmbed = interaction.message.embeds[0];
    if (!originalEmbed) throw new Error('У повідомленні немає ембеда');

    const number = parseCodeFromFooter(originalEmbed.footer?.text)
      || Number(String(interaction.customId).split(/[:_]/).pop());
    const code = Number.isFinite(number) && number > 0 ? formatCode(number) : 'K-???';

    // Прибираємо рядок очікування і додаємо інформацію про виплату
    let newDesc = originalEmbed.description || '';
    newDesc = newDesc.replace('Очікує видачі коштів керівником.', '').trim();
    newDesc += `\n💸 Виплатив: <@${interaction.user.id}>`;

    const paidEmbed = new EmbedBuilder()
      .setTitle(`💰 ${code} · Виплата затверджена`)
      .setDescription(newDesc)
      .addFields(plainFields(originalEmbed.fields))
      .setColor(COLOR.ok)
      .setFooter({ text: originalEmbed.footer?.text ?? `Kaneko Family • ${code}` });

    // Щоб зображення не дублювалося як зовнішнє посилання + вкладення,
    // прив'язуємо його до існуючого вкладення через attachment://
    const attachment = interaction.message.attachments.first();
    if (attachment) {
      paidEmbed.setImage(`attachment://${attachment.name}`);
    } else if (originalEmbed.image?.url) {
      paidEmbed.setImage(originalEmbed.image.url);
    }

    await interaction.message.edit({ embeds: [paidEmbed], components: [] });

    if (Number.isFinite(number) && number > 0) {
      await updateSubmission(number, {
        status: 'paid',
        paidBy: interaction.user.id,
        paidAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error('Paid error:', err);
    const msg = { content: `❌ Не вдалося підтвердити виплату: ${err.message}`, ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
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

    // Прибираємо скріншот із каналу перевірок
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

  await interaction.editReply({
    content: `✅ **Канали готові!**\n\n${created.join('\n')}\n\n📌 Скопіюй ID у змінні середовища:\n\`\`\`\nCHANNEL_CONTRACTS=${ids.CHANNEL_CONTRACTS}\nCHANNEL_REVIEW=${ids.CHANNEL_REVIEW}\nCHANNEL_PAYOUTS=${ids.CHANNEL_PAYOUTS}\n\`\`\`\n\nБот отримав право **Manage Messages**, щоб видаляти скріни з чату.`,
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

client.login(process.env.DISCORD_TOKEN);