require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  getVoiceConnection,
} = require('@discordjs/voice');
const { OpenAI } = require('openai');
const { EdgeTTS } = require('@andresaya/edge-tts');
const fs = require('fs');
const path = require('path');

// ─── Clients ─────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Config ──────────────────────────────────────────────────────────────────
// FREE Microsoft Neural voices via edge-tts — NO API KEY NEEDED
// Change TTS_VOICE in Railway variables to switch voice
// Female options: en-US-JennyNeural, en-US-AriaNeural, en-US-MichelleNeural
//                 en-IN-NeerjaNeural (Indian English), en-GB-SoniaNeural (British)
const TTS_VOICE = process.env.TTS_VOICE || 'en-US-JennyNeural';

// Conversation memory per guild
const conversationHistory = {};

// ─── Register Slash Commands ──────────────────────────────────────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('join')
      .setDescription('Join your voice channel and start listening 🎙️'),
    new SlashCommandBuilder()
      .setName('leave')
      .setDescription('Leave the voice channel 👋'),
    new SlashCommandBuilder()
      .setName('ask')
      .setDescription('Ask Aria a question via text (no mic needed)')
      .addStringOption(opt =>
        opt.setName('question')
           .setDescription('Your question')
           .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('voice')
      .setDescription('Change Aria\'s voice')
      .addStringOption(opt =>
        opt.setName('name')
           .setDescription('Voice name e.g. en-US-AriaNeural')
           .setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('clear')
      .setDescription('Clear conversation history 🧹'),
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('📡 Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
      { body: commands }
    );
    console.log('✅ Slash commands registered!');
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }
}

// ─── TTS: Text → MP3 via edge-tts (FREE, no API key) ─────────────────────────
async function synthesizeSpeech(text, voice = TTS_VOICE) {
  const tts = new EdgeTTS();
  const outPath = path.join('/tmp', `tts_${Date.now()}.mp3`);
  await tts.synthesize(text, voice, {
    rate: '0%',
    volume: '100%',
    pitch: '+0Hz',
    outputFormat: 'audio-24khz-96kbitrate-mono-mp3',
  });
  await tts.toFile(outPath);
  return outPath;
}

// ─── STT: PCM buffer → text via Whisper ──────────────────────────────────────
async function transcribeAudio(pcmBuffer) {
  const wavPath = path.join('/tmp', `stt_${Date.now()}.wav`);
  const wavHeader = createWavHeader(pcmBuffer.length, 48000, 2, 16);
  fs.writeFileSync(wavPath, Buffer.concat([wavHeader, pcmBuffer]));

  const transcript = await openai.audio.transcriptions.create({
    file: fs.createReadStream(wavPath),
    model: 'whisper-1',
    language: 'en',
  });

  fs.unlinkSync(wavPath);
  return transcript.text.trim();
}

function createWavHeader(dataLength, sampleRate, channels, bitDepth) {
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitDepth / 8), 28);
  buffer.writeUInt16LE(channels * (bitDepth / 8), 32);
  buffer.writeUInt16LE(bitDepth, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);
  return buffer;
}

// ─── AI Reply via ChatGPT ─────────────────────────────────────────────────────
async function getAIReply(guildId, userText) {
  if (!conversationHistory[guildId]) {
    conversationHistory[guildId] = [
      {
        role: 'system',
        content:
          'You are a friendly, polite, and helpful AI assistant named Aria. ' +
          'You speak in a warm, concise, and cheerful manner. ' +
          'Keep voice responses under 3 sentences so they are easy to listen to. ' +
          'You are deployed in a Discord voice channel to help users.',
      },
    ];
  }

  conversationHistory[guildId].push({ role: 'user', content: userText });

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: conversationHistory[guildId],
    max_tokens: 300,
  });

  const reply = completion.choices[0].message.content;
  conversationHistory[guildId].push({ role: 'assistant', content: reply });

  // Keep history manageable
  if (conversationHistory[guildId].length > 20) {
    conversationHistory[guildId].splice(1, 2);
  }

  return reply;
}

// ─── Play audio in voice channel ──────────────────────────────────────────────
async function playAudio(connection, filePath) {
  return new Promise((resolve, reject) => {
    const player = createAudioPlayer();
    const resource = createAudioResource(filePath);
    connection.subscribe(player);
    player.play(resource);
    player.on(AudioPlayerStatus.Idle, () => {
      try { fs.unlinkSync(filePath); } catch {}
      resolve();
    });
    player.on('error', reject);
  });
}

// ─── Listen and respond to a user ────────────────────────────────────────────
function listenToUser(connection, userId, guildId) {
  const receiver = connection.receiver;

  const audioStream = receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 1500 },
  });

  const chunks = [];
  audioStream.on('data', chunk => chunks.push(chunk));

  audioStream.on('end', async () => {
    if (chunks.length === 0) return;
    const pcmBuffer = Buffer.concat(chunks);
    if (pcmBuffer.length < 3200) return; // too short, ignore

    try {
      const text = await transcribeAudio(pcmBuffer);
      if (!text || text.length < 2) return;
      console.log(`📝 User said: "${text}"`);

      const reply = await getAIReply(guildId, text);
      console.log(`🤖 Aria: "${reply}"`);

      const audioFile = await synthesizeSpeech(reply);
      await playAudio(connection, audioFile);
    } catch (err) {
      console.error('❌ Voice pipeline error:', err.message);
    }
  });
}

// ─── /join ────────────────────────────────────────────────────────────────────
async function handleJoin(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    return interaction.reply({ content: '❌ Join a voice channel first!', ephemeral: true });
  }

  await interaction.reply(`✅ Joining **${voiceChannel.name}**! Say something and I'll answer 🎙️`);

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: interaction.guildId,
    adapterCreator: interaction.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch {
    connection.destroy();
    return interaction.followUp('❌ Could not connect. Please try again.');
  }

  // Greet
  try {
    const greetAudio = await synthesizeSpeech(
      "Hi there! I'm Aria. Ask me anything and I'll do my best to help you!"
    );
    await playAudio(connection, greetAudio);
  } catch (err) {
    console.error('Greeting failed:', err.message);
  }

  // Listen to anyone who speaks
  connection.receiver.speaking.on('start', userId => {
    listenToUser(connection, userId, interaction.guildId);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      connection.destroy();
    }
  });
}

// ─── /leave ───────────────────────────────────────────────────────────────────
async function handleLeave(interaction) {
  const connection = getVoiceConnection(interaction.guildId);
  if (!connection) {
    return interaction.reply({ content: "I'm not in any voice channel!", ephemeral: true });
  }
  connection.destroy();
  interaction.reply('👋 Bye! See you next time!');
}

// ─── /ask ─────────────────────────────────────────────────────────────────────
async function handleAsk(interaction) {
  await interaction.deferReply();
  const question = interaction.options.getString('question');
  try {
    const reply = await getAIReply(interaction.guildId, question);
    await interaction.editReply(`🤖 **Aria:** ${reply}`);

    const connection = getVoiceConnection(interaction.guildId);
    if (connection) {
      const audioFile = await synthesizeSpeech(reply);
      await playAudio(connection, audioFile);
    }
  } catch (err) {
    console.error(err);
    await interaction.editReply('❌ Something went wrong. Please try again.');
  }
}

// ─── /voice ───────────────────────────────────────────────────────────────────
async function handleVoice(interaction) {
  const voiceName = interaction.options.getString('name');
  try {
    const testAudio = await synthesizeSpeech('Hello! This is my new voice. Do you like it?', voiceName);
    process.env.TTS_VOICE = voiceName; // update for this session
    await interaction.reply(`✅ Voice changed to **${voiceName}**!`);
    const connection = getVoiceConnection(interaction.guildId);
    if (connection) await playAudio(connection, testAudio);
    else fs.unlinkSync(testAudio);
  } catch (err) {
    interaction.reply(`❌ Voice "${voiceName}" not found. Try: en-US-AriaNeural, en-US-JennyNeural, en-IN-NeerjaNeural`);
  }
}

// ─── /clear ───────────────────────────────────────────────────────────────────
function handleClear(interaction) {
  delete conversationHistory[interaction.guildId];
  interaction.reply('🧹 Memory cleared! Starting fresh.');
}

// ─── Interaction Router ───────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  switch (interaction.commandName) {
    case 'join':  return handleJoin(interaction);
    case 'leave': return handleLeave(interaction);
    case 'ask':   return handleAsk(interaction);
    case 'voice': return handleVoice(interaction);
    case 'clear': return handleClear(interaction);
  }
});

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`🤖 Aria is online as ${client.user.tag}`);
  console.log(`🎙️ Using voice: ${TTS_VOICE}`);
  await registerCommands();
});

client.login(process.env.DISCORD_TOKEN);
