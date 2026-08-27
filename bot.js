const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, UserSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, AttachmentBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// ─── Contracts list ───────────────────────────────────────────────
const CONTRACTS = [
  { id: 'balloon1',  name: 'Балонний транзит І',       amount: 150000 },
  { id: 'trophy1',   name: 'Продажа трофеїв І',        amount: 90000  },
  { id: 'master2',   name: 'Майстер на всі руки ІІ',   amount: 230000 },
  { id: 'trophy3',   name: 'Продажа трофеїв ІІІ',      amount: 190000 },
  { id: 'balloon2',  name: 'Балонний транзит ІІ',       amount: 185000 },
  { id: 'root2',     name: 'Під корінь ІІ',             amount: 175000 },
];

// Channels (set these in .env or hardcode after creating channels)
const CHANNEL_CONTRACTS   = process.env.CHANNEL_CONTRACTS;   // 📋・контракти
const CHANNEL_REVIEW      = process.env.CHANNEL_REVIEW;      // 📑・перевірка-контрактів
const CHANNEL_PAYOUTS     = process.env.CHANNEL_PAYOUTS;     // 💰・виплати

// Temp storage for multi-step form state (in production use a DB)
const formState = new Map();

// ─── Utility ──────────────────────────────────────────────────────
function formatMoney(n) {
  return `$${n.toLocaleString('uk-UA')}`;
}

function calcPayout(amount, participantCount) {
  const family  = Math.round(amount * 0.20);
  const pool    = amount - family;
  const perPerson = Math.round(pool / participantCount);
  return { family, pool, perPerson };
}

// ─── Slash command registration ───────────────────────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('контракт')
      .setDescription('Заповнити форму виконаного контракту GTA'),

    new SlashCommandBuilder()
      .setName('setup-channels')
      .setDescription('Створити канали для системи контрактів')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), { body: commands });
    console.log('✅ Slash commands registered');
  } catch (err) {
    console.error('❌ Command registration error:', err);
  }
}

// ─── Bot ready ────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`🤖 Bot online: ${client.user.tag}`);
  await registerCommands();
});

// ─── Interaction handler ──────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  try {
    // ── /контракт ──
    if (interaction.isChatInputCommand() && interaction.commandName === 'контракт') {
      return await handleContractStart(interaction);
    }

    // ── /setup-channels ──
    if (interaction.isChatInputCommand() && interaction.commandName === 'setup-channels') {
      return await handleSetupChannels(interaction);
    }

    // ── Select menus ──
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'select_contract') return await handleContractSelect(interaction);
      if (interaction.customId === 'select_payout')   return await handlePayoutSelect(interaction);
    }

    if (interaction.isUserSelectMenu() && interaction.customId === 'select_members') {
      return await handleMembersSelect(interaction);
    }

    // ── Buttons ──
    if (interaction.isButton()) {
      if (interaction.customId === 'btn_attach_screenshot') return await handleAttachScreenshot(interaction);
      if (interaction.customId === 'btn_submit_contract')   return await handleFinalSubmit(interaction);
      if (interaction.customId.startsWith('btn_approve_'))  return await handleApprove(interaction);
      if (interaction.customId.startsWith('btn_reject_'))   return await handleReject(interaction);
    }

    // ── Modals ──
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'modal_screenshot') return await handleScreenshotModal(interaction);
      if (interaction.customId.startsWith('modal_reject_')) return await handleRejectModal(interaction);
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

// ─── Step 1: Start — choose contract ─────────────────────────────
async function handleContractStart(interaction) {
  // Only in 📋・контракти
  if (CHANNEL_CONTRACTS && interaction.channelId !== CHANNEL_CONTRACTS) {
    return interaction.reply({ content: `❌ Команду можна використовувати тільки в <#${CHANNEL_CONTRACTS}>`, ephemeral: true });
  }

  formState.set(interaction.user.id, { userId: interaction.user.id, step: 'contract' });

  const options = CONTRACTS.map(c => ({
    label: c.name,
    description: `Виплата: ${formatMoney(c.amount)}`,
    value: c.id,
  }));

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('select_contract')
      .setPlaceholder('Обери контракт...')
      .addOptions(options)
  );

  const embed = new EmbedBuilder()
    .setTitle('📋 Новий контракт')
    .setDescription('**Крок 1/4** — Обери тип контракту')
    .setColor(0x2b2d31)
    .setFooter({ text: 'GTA Contract System' });

  await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

// ─── Step 2: Members select ───────────────────────────────────────
async function handleContractSelect(interaction) {
  const state = formState.get(interaction.user.id);
  if (!state) return interaction.reply({ content: '❌ Сесія застаріла. Почни знову.', ephemeral: true });

  const contractId = interaction.values[0];
  const contract = CONTRACTS.find(c => c.id === contractId);
  state.contract = contract;
  state.step = 'members';

  const row = new ActionRowBuilder().addComponents(
    new UserSelectMenuBuilder()
      .setCustomId('select_members')
      .setPlaceholder('Обери учасників контракту...')
      .setMinValues(1)
      .setMaxValues(4)
  );

  const embed = new EmbedBuilder()
    .setTitle('📋 Новий контракт')
    .setDescription(`**Крок 2/4** — Обери учасників\n\n🎮 Контракт: **${contract.name}**\n💵 Сума: **${formatMoney(contract.amount)}**`)
    .setColor(0x2b2d31)
    .setFooter({ text: 'Вибери всіх, хто брав участь (включаючи себе)' });

  await interaction.update({ embeds: [embed], components: [row] });
}

// ─── Step 3: Screenshot ───────────────────────────────────────────
async function handleMembersSelect(interaction) {
  const state = formState.get(interaction.user.id);
  if (!state) return interaction.reply({ content: '❌ Сесія застаріла. Почни знову.', ephemeral: true });

  const members = interaction.values; // array of user IDs
  state.members = members;
  state.step = 'screenshot';

  const { family, perPerson } = calcPayout(state.contract.amount, members.length);
  const memberMentions = members.map(id => `<@${id}>`).join(', ');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_attach_screenshot')
      .setLabel('📸 Прикріпити скрін')
      .setStyle(ButtonStyle.Primary)
  );

  const embed = new EmbedBuilder()
    .setTitle('📋 Новий контракт')
    .setDescription(`**Крок 3/4** — Прикріпи скріншот виконання`)
    .addFields(
      { name: '🎮 Контракт', value: state.contract.name, inline: true },
      { name: '💵 Сума', value: formatMoney(state.contract.amount), inline: true },
      { name: '👥 Учасники', value: memberMentions },
      { name: '🏠 Сім\'ї (20%)', value: formatMoney(family), inline: true },
      { name: '💰 Кожному учаснику', value: formatMoney(perPerson), inline: true },
    )
    .setColor(0x2b2d31)
    .setFooter({ text: 'Натисни кнопку та вкажи посилання на скрін' });

  await interaction.update({ embeds: [embed], components: [row] });
}

// ─── Step 4: Screenshot URL via modal ────────────────────────────
async function handleAttachScreenshot(interaction) {
  const state = formState.get(interaction.user.id);
  if (!state) return interaction.reply({ content: '❌ Сесія застаріла. Почни знову.', ephemeral: true });

  const modal = new ModalBuilder()
    .setCustomId('modal_screenshot')
    .setTitle('Скріншот контракту');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('screenshot_url')
        .setLabel('Посилання на скріншот (imgur, discord CDN, etc.)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('https://imgur.com/...')
        .setRequired(true)
    )
  );

  await interaction.showModal(modal);
}

async function handleScreenshotModal(interaction) {
  const state = formState.get(interaction.user.id);
  if (!state) return interaction.reply({ content: '❌ Сесія застаріла. Почни знову.', ephemeral: true });

  const screenshotUrl = interaction.fields.getTextInputValue('screenshot_url');
  state.screenshotUrl = screenshotUrl;
  state.step = 'payout';

  // Step 4: Choose payout option
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('select_payout')
      .setPlaceholder('Обери варіант виплати...')
      .addOptions([
        { label: '💰 Отримати виплату собі', value: 'self', description: 'Твоя частка зараховується тобі' },
        { label: '🏠 Віддати виплату сім\'ї', value: 'family', description: 'Твоя частка йде у фонд сім\'ї' },
      ])
  );

  const { family, perPerson } = calcPayout(state.contract.amount, state.members.length);
  const memberMentions = state.members.map(id => `<@${id}>`).join(', ');

  const embed = new EmbedBuilder()
    .setTitle('📋 Новий контракт')
    .setDescription(`**Крок 4/4** — Обери варіант виплати`)
    .addFields(
      { name: '🎮 Контракт', value: state.contract.name, inline: true },
      { name: '💵 Сума', value: formatMoney(state.contract.amount), inline: true },
      { name: '👥 Учасники', value: memberMentions },
      { name: '🏠 Сім\'ї (20%)', value: formatMoney(family), inline: true },
      { name: '💰 Твоя частка', value: formatMoney(perPerson), inline: true },
    )
    .setImage(screenshotUrl)
    .setColor(0x2b2d31);

  await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

// ─── Final: Submit ────────────────────────────────────────────────
async function handlePayoutSelect(interaction) {
  const state = formState.get(interaction.user.id);
  if (!state) return interaction.reply({ content: '❌ Сесія застаріла. Почни знову.', ephemeral: true });

  state.payoutChoice = interaction.values[0]; // 'self' | 'family'

  const { family, perPerson } = calcPayout(state.contract.amount, state.members.length);
  const memberMentions = state.members.map(id => `<@${id}>`).join(', ');
  const payoutText = state.payoutChoice === 'self'
    ? '💰 Отримати виплату собі'
    : '🏠 Віддати виплату сім\'ї';

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('btn_submit_contract')
      .setLabel('✅ Відправити заявку')
      .setStyle(ButtonStyle.Success)
  );

  const embed = new EmbedBuilder()
    .setTitle('📋 Підтвердження контракту')
    .setDescription('Перевір дані та відправ заявку')
    .addFields(
      { name: '🎮 Контракт', value: state.contract.name, inline: true },
      { name: '💵 Загальна сума', value: formatMoney(state.contract.amount), inline: true },
      { name: '👥 Учасники', value: memberMentions },
      { name: '🏠 Сім\'ї (20%)', value: formatMoney(family), inline: true },
      { name: '💰 Кожному учаснику', value: formatMoney(perPerson), inline: true },
      { name: '📤 Ваш вибір', value: payoutText },
    )
    .setImage(state.screenshotUrl)
    .setColor(0xf0c030);

  await interaction.update({ embeds: [embed], components: [row] });
}

async function handleFinalSubmit(interaction) {
  const state = formState.get(interaction.user.id);
  if (!state) return interaction.reply({ content: '❌ Сесія застаріла. Почни знову.', ephemeral: true });

  await interaction.deferUpdate();

  const { family, perPerson } = calcPayout(state.contract.amount, state.members.length);
  const memberMentions = state.members.map(id => `<@${id}>`).join(', ');
  const payoutText = state.payoutChoice === 'self'
    ? '💰 Отримати виплату собі'
    : '🏠 Віддати виплату сім\'ї';

  const submittedAt = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

  // Embed for review channel
  const reviewEmbed = new EmbedBuilder()
    .setTitle('📑 Новий контракт на перевірку')
    .setDescription(`Подав: <@${interaction.user.id}>`)
    .addFields(
      { name: '🎮 Контракт', value: state.contract.name, inline: true },
      { name: '💵 Загальна сума', value: formatMoney(state.contract.amount), inline: true },
      { name: '👥 Учасники', value: memberMentions },
      { name: '🏠 Сім\'ї (20%)', value: formatMoney(family), inline: true },
      { name: '💰 Кожному учаснику', value: formatMoney(perPerson), inline: true },
      { name: '📤 Вибір виплати', value: payoutText },
      { name: '🕐 Час подання', value: submittedAt },
    )
    .setImage(state.screenshotUrl)
    .setColor(0xf0c030)
    .setFooter({ text: `ID: ${interaction.user.id}` });

  const approveRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`btn_approve_${interaction.user.id}_${state.contract.id}`)
      .setLabel('✅ Підтвердити')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`btn_reject_${interaction.user.id}`)
      .setLabel('❌ Відхилити')
      .setStyle(ButtonStyle.Danger),
  );

  // Send to review channel
  const reviewChannel = CHANNEL_REVIEW ? interaction.guild.channels.cache.get(CHANNEL_REVIEW) : null;
  if (reviewChannel) {
    await reviewChannel.send({ embeds: [reviewEmbed], components: [approveRow] });
  }

  // Confirm to user
  const confirmEmbed = new EmbedBuilder()
    .setTitle('✅ Заявку відправлено!')
    .setDescription('Твій контракт відправлено на перевірку. Після підтвердження з\'явиться інформація у каналі виплат.')
    .setColor(0x57f287);

  await interaction.editReply({ embeds: [confirmEmbed], components: [] });
  formState.delete(interaction.user.id);
}

// ─── Approve / Reject ─────────────────────────────────────────────
async function handleApprove(interaction) {
  await interaction.deferReply({ ephemeral: true });

  // Parse original embed
  const originalEmbed = interaction.message.embeds[0];
  const fields = {};
  originalEmbed.fields.forEach(f => { fields[f.name] = f.value; });

  // Build approved embed for payouts channel
  const approvedEmbed = new EmbedBuilder()
    .setTitle('💰 Виплата затверджена')
    .setDescription(`✅ Перевірив: <@${interaction.user.id}>`)
    .addFields(
      ...originalEmbed.fields.filter(f => f.name !== '🕐 Час подання'),
      { name: '🕐 Затверджено', value: new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' }) }
    )
    .setImage(originalEmbed.image?.url || null)
    .setColor(0x57f287)
    .setFooter(originalEmbed.footer);

  const payoutsChannel = CHANNEL_PAYOUTS ? interaction.guild.channels.cache.get(CHANNEL_PAYOUTS) : null;
  if (payoutsChannel) {
    await payoutsChannel.send({ embeds: [approvedEmbed] });
  }

  // Update review message
  const approvedReviewEmbed = EmbedBuilder.from(originalEmbed)
    .setTitle('📑 Контракт ✅ ЗАТВЕРДЖЕНО')
    .setColor(0x57f287)
    .setDescription(`${originalEmbed.description}\n\n✅ Затверджено: <@${interaction.user.id}>`);

  await interaction.message.edit({ embeds: [approvedReviewEmbed], components: [] });
  await interaction.editReply({ content: '✅ Контракт затверджено!' });
}

async function handleReject(interaction) {
  const submitterId = interaction.customId.split('_')[2];

  const modal = new ModalBuilder()
    .setCustomId(`modal_reject_${submitterId}`)
    .setTitle('Причина відхилення');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('reject_reason')
        .setLabel('Вкажи причину відхилення')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
    )
  );

  await interaction.showModal(modal);
}

async function handleRejectModal(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const submitterId = interaction.customId.split('_')[2];
  const reason = interaction.fields.getTextInputValue('reject_reason');
  const originalEmbed = interaction.message.embeds[0];

  // Update review message
  const rejectedEmbed = EmbedBuilder.from(originalEmbed)
    .setTitle('📑 Контракт ❌ ВІДХИЛЕНО')
    .setColor(0xed4245)
    .setDescription(`${originalEmbed.description}\n\n❌ Відхилив: <@${interaction.user.id}>\n📝 Причина: ${reason}`);

  await interaction.message.edit({ embeds: [rejectedEmbed], components: [] });

  // DM submitter
  try {
    const submitter = await interaction.guild.members.fetch(submitterId);
    await submitter.send({
      embeds: [new EmbedBuilder()
        .setTitle('❌ Ваш контракт відхилено')
        .setDescription(`**Причина:** ${reason}`)
        .setColor(0xed4245)]
    });
  } catch {}

  await interaction.editReply({ content: '❌ Контракт відхилено.' });
}

// ─── Setup channels command ───────────────────────────────────────
async function handleSetupChannels(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const guild = interaction.guild;

  // Find or create category
  let category = guild.channels.cache.find(c => c.name === '🎮 GTA Контракти' && c.type === ChannelType.GuildCategory);
  if (!category) {
    category = await guild.channels.create({ name: '🎮 GTA Контракти', type: ChannelType.GuildCategory });
  }

  const channelNames = [
    { name: '📋・контракти',          key: 'CONTRACTS' },
    { name: '📑・перевірка-контрактів', key: 'REVIEW'    },
    { name: '💰・виплати',            key: 'PAYOUTS'   },
  ];

  const created = [];
  for (const ch of channelNames) {
    const exists = guild.channels.cache.find(c => c.name === ch.name);
    if (!exists) {
      const newCh = await guild.channels.create({ name: ch.name, type: ChannelType.GuildText, parent: category.id });
      created.push(`<#${newCh.id}> (${ch.key}: \`${newCh.id}\`)`);
    } else {
      created.push(`<#${exists.id}> — вже існує (${ch.key}: \`${exists.id}\`)`);
    }
  }

  await interaction.editReply({
    content: `✅ **Канали готові!**\n\n${created.join('\n')}\n\n📌 Скопіюй ID каналів у \`.env\` файл:\n\`\`\`\nCHANNEL_CONTRACTS=...\nCHANNEL_REVIEW=...\nCHANNEL_PAYOUTS=...\n\`\`\``,
  });
}

// ─── Login ────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
