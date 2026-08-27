const {
  Client, GatewayIntentBits, Partials, REST, Routes,
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, UserSelectMenuBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, EmbedBuilder,
  PermissionFlagsBits, ChannelType, Events
} = require('discord.js');
require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ─── Contracts ────────────────────────────────────────────────────
const CONTRACTS = [
  { id: 'balloon1', name: 'Балонний транзит І',     amount: 150000 },
  { id: 'trophy1',  name: 'Продажа трофеїв І',      amount: 90000  },
  { id: 'master2',  name: 'Майстер на всі руки ІІ', amount: 230000 },
  { id: 'trophy3',  name: 'Продажа трофеїв ІІІ',    amount: 190000 },
  { id: 'balloon2', name: 'Балонний транзит ІІ',     amount: 185000 },
  { id: 'root2',    name: 'Під корінь ІІ',           amount: 175000 },
];

const CHANNEL_CONTRACTS = process.env.CHANNEL_CONTRACTS;
const CHANNEL_REVIEW    = process.env.CHANNEL_REVIEW;
const CHANNEL_PAYOUTS   = process.env.CHANNEL_PAYOUTS;

// formState: userId -> state object
const formState = new Map();
// awaitingScreenshot: userId -> true (waiting for image message)
const awaitingScreenshot = new Map();

// ─── Helpers ──────────────────────────────────────────────────────
function formatMoney(n) {
  return `$${n.toLocaleString('uk-UA')}`;
}

function calcPayout(amount, count) {
  const family    = Math.round(amount * 0.20);
  const perPerson = Math.round((amount - family) / count);
  return { family, perPerson };
}

// ─── Register slash commands ──────────────────────────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('контракт')
      .setDescription('Заповнити форму виконаного контракту'),
    new SlashCommandBuilder()
      .setName('setup-channels')
      .setDescription('Створити канали для системи контрактів')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(
      Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
      { body: commands }
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
  if (!awaitingScreenshot.has(message.author.id)) return;

  const state = formState.get(message.author.id);
  if (!state) return;

  // Check if message has an image attachment
  const image = message.attachments.find(a =>
    a.contentType && a.contentType.startsWith('image/')
  );

  if (!image) {
    await message.reply({ content: '❌ Надішли саме **зображення** (не файл, не посилання). Спробуй ще раз.', ephemeral: false });
    return;
  }

  // Got the image!
  state.screenshotUrl = image.url;
  state.screenshotMessage = message; // save to delete later
  awaitingScreenshot.delete(message.author.id);

  // Delete the user's image message to keep channel clean
  try { await message.delete(); } catch {}

  // Show payout choice
  await showPayoutStep(message, state);
});

// ─── Interaction handler ──────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'контракт')      return await handleStart(interaction);
      if (interaction.commandName === 'setup-channels') return await handleSetupChannels(interaction);
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'select_contract') return await handleContractSelect(interaction);
      if (interaction.customId === 'select_payout')   return await handlePayoutSelect(interaction);
    }

    if (interaction.isUserSelectMenu() && interaction.customId === 'select_members') {
      return await handleMembersSelect(interaction);
    }

    if (interaction.isButton()) {
      if (interaction.customId === 'btn_submit_contract')          return await handleFinalSubmit(interaction);
      if (interaction.customId.startsWith('btn_approve_'))         return await handleApprove(interaction);
      if (interaction.customId.startsWith('btn_reject_'))          return await handleReject(interaction);
    }

    if (interaction.isModalSubmit()) {
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

// ─── Step 1: Choose contract ──────────────────────────────────────
async function handleStart(interaction) {
  if (CHANNEL_CONTRACTS && interaction.channelId !== CHANNEL_CONTRACTS) {
    return interaction.reply({
      content: `❌ Команду можна використовувати тільки в <#${CHANNEL_CONTRACTS}>`,
      ephemeral: true
    });
  }

  formState.set(interaction.user.id, { userId: interaction.user.id, step: 'contract' });
  awaitingScreenshot.delete(interaction.user.id);

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('select_contract')
      .setPlaceholder('Обери контракт...')
      .addOptions(CONTRACTS.map(c => ({
        label: c.name,
        description: `Виплата: ${formatMoney(c.amount)}`,
        value: c.id,
      })))
  );

  const embed = new EmbedBuilder()
    .setTitle('📋 Новий контракт')
    .setDescription('**Крок 1/4** — Обери тип контракту')
    .setColor(0x2b2d31)
    .setFooter({ text: 'Kaneko Family' });

  await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

// ─── Step 2: Choose members ───────────────────────────────────────
async function handleContractSelect(interaction) {
  const state = formState.get(interaction.user.id);
  if (!state) return interaction.reply({ content: '❌ Сесія застаріла. Почни знову /контракт', ephemeral: true });

  const contract = CONTRACTS.find(c => c.id === interaction.values[0]);
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
    .setDescription(`**Крок 2/4** — Обери учасників\n\n🎯 Контракт: **${contract.name}**\n💵 Сума: **${formatMoney(contract.amount)}**`)
    .setColor(0x2b2d31)
    .setFooter({ text: 'Вибери всіх, хто брав участь (включаючи себе)' });

  await interaction.update({ embeds: [embed], components: [row] });
}

// ─── Step 3: Send screenshot in chat ─────────────────────────────
async function handleMembersSelect(interaction) {
  const state = formState.get(interaction.user.id);
  if (!state) return interaction.reply({ content: '❌ Сесія застаріла. Почни знову /контракт', ephemeral: true });

  state.members = interaction.values;
  state.step = 'screenshot';

  const { family, perPerson } = calcPayout(state.contract.amount, state.members.length);
  const memberMentions = state.members.map(id => `<@${id}>`).join(', ');

  // Tell user to send a photo in this channel
  const embed = new EmbedBuilder()
    .setTitle('📋 Новий контракт')
    .setDescription(`**Крок 3/4** — Надішли скріншот виконання\n\n📸 **Надішли фото прямо в цей канал** наступним повідомленням`)
    .addFields(
      { name: '🎯 Контракт',         value: state.contract.name,             inline: true },
      { name: '💵 Сума',             value: formatMoney(state.contract.amount), inline: true },
      { name: '👥 Учасники',         value: memberMentions },
      { name: '🏠 Сім\'ї (20%)',     value: formatMoney(family),              inline: true },
      { name: '💰 Кожному учаснику', value: formatMoney(perPerson),           inline: true },
    )
    .setColor(0xf0c030)
    .setFooter({ text: 'Просто прикріпи фото і надішли — бот його підхопить автоматично' });

  await interaction.update({ embeds: [embed], components: [] });

  // Mark this user as awaiting a screenshot message
  awaitingScreenshot.set(interaction.user.id, true);
}

// ─── Step 4: Payout choice (called after image received) ──────────
async function showPayoutStep(message, state) {
  const { family, perPerson } = calcPayout(state.contract.amount, state.members.length);
  const memberMentions = state.members.map(id => `<@${id}>`).join(', ');

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('select_payout')
      .setPlaceholder('Обери варіант виплати...')
      .addOptions([
        { label: '💰 Отримати виплату собі',    value: 'self',   description: 'Твоя частка зараховується тобі' },
        { label: '🏠 Віддати виплату сім\'ї',   value: 'family', description: 'Твоя частка йде у фонд сім\'ї' },
      ])
  );

  const embed = new EmbedBuilder()
    .setTitle('📋 Новий контракт')
    .setDescription('**Крок 4/4** — Обери варіант виплати')
    .addFields(
      { name: '🎯 Контракт',         value: state.contract.name,               inline: true },
      { name: '💵 Сума',             value: formatMoney(state.contract.amount), inline: true },
      { name: '👥 Учасники',         value: memberMentions },
      { name: '🏠 Сім\'ї (20%)',     value: formatMoney(family),               inline: true },
      { name: '💰 Твоя частка',      value: formatMoney(perPerson),             inline: true },
    )
    .setImage(state.screenshotUrl)
    .setColor(0x2b2d31);

  // Send ephemeral-style reply — use DM or channel message
  const sent = await message.channel.send({
    content: `<@${state.userId}>`,
    embeds: [embed],
    components: [row],
  });

  // Store message id so we can edit it later
  state.payoutMessageId = sent.id;
  state.payoutChannelId = sent.channelId;
}

// ─── Step 4 handler: payout selected ─────────────────────────────
async function handlePayoutSelect(interaction) {
  const state = formState.get(interaction.user.id);
  if (!state) return interaction.reply({ content: '❌ Сесія застаріла. Почни знову /контракт', ephemeral: true });

  state.payoutChoice = interaction.values[0];

  const { family, perPerson } = calcPayout(state.contract.amount, state.members.length);
  const memberMentions = state.members.map(id => `<@${id}>`).join(', ');
  const payoutText = state.payoutChoice === 'self' ? '💰 Отримати виплату собі' : '🏠 Віддати виплату сім\'ї';

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
      { name: '🎯 Контракт',         value: state.contract.name,               inline: true },
      { name: '💵 Загальна сума',    value: formatMoney(state.contract.amount), inline: true },
      { name: '👥 Учасники',         value: memberMentions },
      { name: '🏠 Сім\'ї (20%)',     value: formatMoney(family),               inline: true },
      { name: '💰 Кожному учаснику', value: formatMoney(perPerson),             inline: true },
      { name: '📤 Ваш вибір',        value: payoutText },
    )
    .setImage(state.screenshotUrl)
    .setColor(0xf0c030);

  await interaction.update({ embeds: [embed], components: [row] });
}

// ─── Final submit ─────────────────────────────────────────────────
async function handleFinalSubmit(interaction) {
  const state = formState.get(interaction.user.id);
  if (!state) return interaction.reply({ content: '❌ Сесія застаріла. Почни знову /контракт', ephemeral: true });

  await interaction.deferUpdate();

  const { family, perPerson } = calcPayout(state.contract.amount, state.members.length);
  const memberMentions = state.members.map(id => `<@${id}>`).join(', ');
  const payoutText = state.payoutChoice === 'self' ? '💰 Отримати виплату собі' : '🏠 Віддати виплату сім\'ї';
  const submittedAt = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

  const reviewEmbed = new EmbedBuilder()
    .setTitle('📑 Новий контракт на перевірку')
    .setDescription(`Подав: <@${interaction.user.id}>`)
    .addFields(
      { name: '🎯 Контракт',         value: state.contract.name,               inline: true },
      { name: '💵 Загальна сума',    value: formatMoney(state.contract.amount), inline: true },
      { name: '👥 Учасники',         value: memberMentions },
      { name: '🏠 Сім\'ї (20%)',     value: formatMoney(family),               inline: true },
      { name: '💰 Кожному учаснику', value: formatMoney(perPerson),             inline: true },
      { name: '📤 Вибір виплати',    value: payoutText },
      { name: '🕐 Час подання',      value: submittedAt },
    )
    .setImage(state.screenshotUrl)
    .setColor(0xf0c030)
    .setFooter({ text: `Kaneko Family • ID: ${interaction.user.id}` });

  const approveRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`btn_approve_${interaction.user.id}`)
      .setLabel('✅ Підтвердити')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`btn_reject_${interaction.user.id}`)
      .setLabel('❌ Відхилити')
      .setStyle(ButtonStyle.Danger),
  );

  const reviewChannel = CHANNEL_REVIEW ? interaction.guild.channels.cache.get(CHANNEL_REVIEW) : null;
  if (reviewChannel) {
    await reviewChannel.send({ embeds: [reviewEmbed], components: [approveRow] });
  }

  const confirmEmbed = new EmbedBuilder()
    .setTitle('✅ Заявку відправлено!')
    .setDescription('Контракт відправлено на перевірку. Після підтвердження виплата з\'явиться у відповідному каналі.')
    .setColor(0x57f287)
    .setFooter({ text: 'Kaneko Family' });

  await interaction.editReply({ embeds: [confirmEmbed], components: [] });

  // Delete the bot's payout message from the channel after a short delay
  setTimeout(async () => {
    try { await interaction.message.delete(); } catch {}
  }, 3000);

  formState.delete(interaction.user.id);
}

// ─── Approve ──────────────────────────────────────────────────────
async function handleApprove(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const originalEmbed = interaction.message.embeds[0];

  // Filter out the old timestamp field, add new one
  const fields = originalEmbed.fields
    .filter(f => f.name !== '🕐 Час подання')
    .concat({ name: '🕐 Затверджено', value: new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' }) });

  const approvedEmbed = new EmbedBuilder()
    .setTitle('💰 Виплата затверджена')
    .setDescription(`✅ Перевірив: <@${interaction.user.id}>`)
    .addFields(fields)
    .setColor(0x57f287)
    .setFooter({ text: 'Kaneko Family' });

  // Set image only if it exists
  if (originalEmbed.image?.url) {
    approvedEmbed.setImage(originalEmbed.image.url);
  }

  const payoutsChannel = CHANNEL_PAYOUTS ? interaction.guild.channels.cache.get(CHANNEL_PAYOUTS) : null;
  if (payoutsChannel) {
    await payoutsChannel.send({ embeds: [approvedEmbed] });
  }

  // Update the review message
  const updatedEmbed = new EmbedBuilder()
    .setTitle('📑 Контракт ✅ ЗАТВЕРДЖЕНО')
    .setDescription(`${originalEmbed.description ?? ''}\n\n✅ Затверджено: <@${interaction.user.id}>`)
    .addFields(originalEmbed.fields)
    .setColor(0x57f287)
    .setFooter(originalEmbed.footer ?? { text: 'Kaneko Family' });

  if (originalEmbed.image?.url) {
    updatedEmbed.setImage(originalEmbed.image.url);
  }

  await interaction.message.edit({ embeds: [updatedEmbed], components: [] });
  await interaction.editReply({ content: '✅ Контракт затверджено і виплату відправлено!' });
}

// ─── Reject ───────────────────────────────────────────────────────
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

  const rejectedEmbed = EmbedBuilder.from(originalEmbed)
    .setTitle('📑 Контракт ❌ ВІДХИЛЕНО')
    .setColor(0xed4245)
    .setDescription(`${originalEmbed.description}\n\n❌ Відхилив: <@${interaction.user.id}>\n📝 Причина: ${reason}`);

  await interaction.message.edit({ embeds: [rejectedEmbed], components: [] });

  try {
    const submitter = await interaction.guild.members.fetch(submitterId);
    await submitter.send({
      embeds: [new EmbedBuilder()
        .setTitle('❌ Ваш контракт відхилено')
        .setDescription(`**Причина:** ${reason}`)
        .setColor(0xed4245)
        .setFooter({ text: 'Kaneko Family' })]
    });
  } catch {}

  await interaction.editReply({ content: '❌ Контракт відхилено.' });
}

// ─── Setup channels ───────────────────────────────────────────────
async function handleSetupChannels(interaction) {
  await interaction.deferReply({ ephemeral: true });
  const guild = interaction.guild;

  let category = guild.channels.cache.find(
    c => c.name === '🏠 Kaneko Family' && c.type === ChannelType.GuildCategory
  );
  if (!category) {
    category = await guild.channels.create({ name: '🏠 Kaneko Family', type: ChannelType.GuildCategory });
  }

  const channelDefs = [
    { name: '📋・контракти' },
    { name: '📑・перевірка-контрактів' },
    { name: '💰・виплати' },
  ];

  const created = [];
  for (const ch of channelDefs) {
    const exists = guild.channels.cache.find(c => c.name === ch.name);
    if (!exists) {
      const newCh = await guild.channels.create({ name: ch.name, type: ChannelType.GuildText, parent: category.id });
      created.push(`<#${newCh.id}> — створено (\`${newCh.id}\`)`);
    } else {
      created.push(`<#${exists.id}> — вже існує (\`${exists.id}\`)`);
    }
  }

  await interaction.editReply({
    content: `✅ **Канали готові!**\n\n${created.join('\n')}\n\n📌 Скопіюй ID у змінні середовища:\n\`\`\`\nCHANNEL_CONTRACTS=...\nCHANNEL_REVIEW=...\nCHANNEL_PAYOUTS=...\n\`\`\``,
  });
}

// ─── Login ────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
