require('dotenv').config();

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (caught):', err?.message || err);
});
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
const { EdgeTTS } = require('@andresaya/edge-tts');
const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const TTS_VOICE = process.env.TTS_VOICE || 'en-US-JennyNeural';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // optional fallback

// Conversation memory per guild
const conversationHistory = {};

// ─── Discord Client ───────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── Register Slash Commands ──────────────────────────────────────────────────
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('join')
      .setDescription('Join your voice channel 🎙️'),
    new SlashCommandBuilder()
      .setName('leave')
      .setDescription('Leave the voice channel 👋'),
    new SlashCommandBuilder()
      .setName('ask')
      .setDescription('Ask Aria a question via text')
      .addStringOption(opt =>
        opt.setName('question').setDescription('Your question').setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('voice')
      .setDescription("Change Aria's voice")
      .addStringOption(opt =>
        opt.setName('name').setDescription('Voice e.g. en-US-AriaNeural').setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('clear')
      .setDescription('Clear conversation memory 🧹'),
    new SlashCommandBuilder()
      .setName('imagine')
      .setDescription('Generate an image from a description 🎨')
      .addStringOption(opt =>
        opt.setName('prompt').setDescription('Describe the image you want').setRequired(true)
      )
      .addStringOption(opt =>
        opt.setName('style')
          .setDescription('Optional style (e.g. realistic, anime, oil painting, watercolor)')
          .setRequired(false)
      ),
  ].map(cmd => cmd.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('📡 Registering slash commands...');
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands });
    console.log('✅ Slash commands registered!');
  } catch (err) {
    console.error('❌ Failed to register commands:', err.message);
  }
}

// ─── AI Reply: Groq (free) → OpenAI (fallback) ───────────────────────────────
async function getAIReply(guildId, userText) {
  if (!conversationHistory[guildId]) {
    conversationHistory[guildId] = [
      {
        role: 'system',
        content:
          'You are a friendly, polite, and helpful AI assistant named Aria. ' +
          'Speak in a warm, concise, cheerful manner. ' +
          'Keep voice responses under 3 sentences — easy to listen to.',
      },
    ];
  }

  conversationHistory[guildId].push({ role: 'user', content: userText });

  let reply = null;

  // ── Try Groq first (FREE, no CC needed) ──
  if (GROQ_API_KEY) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: conversationHistory[guildId],
          max_tokens: 300,
        }),
      });
      const data = await res.json();
      if (data.choices?.[0]?.message?.content) {
        reply = data.choices[0].message.content;
        console.log('✅ Reply from Groq (free)');
      } else {
        console.warn('⚠️ Groq response unexpected:', JSON.stringify(data));
      }
    } catch (err) {
      console.warn('⚠️ Groq failed, trying OpenAI fallback:', err.message);
    }
  }

  // ── Fallback: OpenAI ──
  if (!reply && OPENAI_API_KEY) {
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: conversationHistory[guildId],
          max_tokens: 300,
        }),
      });
      const data = await res.json();
      if (data.choices?.[0]?.message?.content) {
        reply = data.choices[0].message.content;
        console.log('✅ Reply from OpenAI (fallback)');
      }
    } catch (err) {
      console.error('❌ OpenAI also failed:', err.message);
    }
  }

  if (!reply) {
    reply = "Sorry, I'm having trouble connecting to my brain right now. Please try again in a moment!";
  }

  conversationHistory[guildId].push({ role: 'assistant', content: reply });
  if (conversationHistory[guildId].length > 20) {
    conversationHistory[guildId].splice(1, 2);
  }

  return reply;
}

// ─── STT: mic audio → text via Groq Whisper (free) or OpenAI Whisper ─────────
async function transcribeAudio(pcmBuffer) {
  const wavPath = path.join('/tmp', `stt_${Date.now()}.wav`);
  const wavHeader = createWavHeader(pcmBuffer.length, 48000, 2, 16);
  fs.writeFileSync(wavPath, Buffer.concat([wavHeader, pcmBuffer]));

  const formData = new FormData();
  formData.append('file', new Blob([fs.readFileSync(wavPath)], { type: 'audio/wav' }), 'audio.wav');
  formData.append('model', 'whisper-large-v3-turbo');
  formData.append('language', 'en');

  let transcript = null;

  // Try Groq Whisper (free)
  if (GROQ_API_KEY) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
        body: formData,
      });
      const data = await res.json();
      if (data.text) {
        transcript = data.text.trim();
        console.log('✅ STT from Groq Whisper (free)');
      }
    } catch (err) {
      console.warn('⚠️ Groq Whisper failed:', err.message);
    }
  }

  // Fallback: OpenAI Whisper
  if (!transcript && OPENAI_API_KEY) {
    try {
      const formData2 = new FormData();
      formData2.append('file', new Blob([fs.readFileSync(wavPath)], { type: 'audio/wav' }), 'audio.wav');
      formData2.append('model', 'whisper-1');
      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
        body: formData2,
      });
      const data = await res.json();
      transcript = data.text?.trim() || '';
      console.log('✅ STT from OpenAI Whisper (fallback)');
    } catch (err) {
      console.error('❌ OpenAI Whisper also failed:', err.message);
    }
  }

  try { fs.unlinkSync(wavPath); } catch {}
  return transcript || '';
}

function createWavHeader(dataLength, sampleRate, channels, bitDepth) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataLength, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22); b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * channels * (bitDepth / 8), 28);
  b.writeUInt16LE(channels * (bitDepth / 8), 32); b.writeUInt16LE(bitDepth, 34);
  b.write('data', 36); b.writeUInt32LE(dataLength, 40);
  return b;
}

// ─── TTS: text → MP3 via edge-tts (FREE) ─────────────────────────────────────
async function synthesizeSpeech(text, voice = process.env.TTS_VOICE || TTS_VOICE) {
  const tts = new EdgeTTS();
  const outPath = path.join('/tmp', `tts_${Date.now()}.mp3`);
  await tts.synthesize(text, voice, {
    rate: '0%', volume: '100%', pitch: '+0Hz',
    outputFormat: 'audio-24khz-96kbitrate-mono-mp3',
  });
  await tts.toFile(outPath);
  return outPath;
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

// ─── Listen and respond to a user speaking ───────────────────────────────────
function listenToUser(connection, userId, guildId, textChannel) {
  const audioStream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: 1500 },
  });

  const chunks = [];
  audioStream.on('data', chunk => chunks.push(chunk));
  audioStream.on('end', async () => {
    if (chunks.length === 0) return;
    const pcmBuffer = Buffer.concat(chunks);
    if (pcmBuffer.length < 3200) return;

    try {
      const text = await transcribeAudio(pcmBuffer);
      if (!text || text.length < 2) return;
      console.log(`📝 User said: "${text}"`);

      const reply = await getAIReply(guildId, text);
      console.log(`🤖 Aria: "${reply}"`);

      // Try voice first, fall back to text channel
      try {
        const audioFile = await synthesizeSpeech(reply);
        await playAudio(connection, audioFile);
      } catch (err) {
        console.warn('⚠️ Audio playback failed, sending text reply:', err.message);
        if (textChannel) {
          await textChannel.send(`🤖 **Aria:** ${reply}`);
        }
      }
    } catch (err) {
      console.error('❌ Voice pipeline error:', err.message);
      if (textChannel) {
        await textChannel.send('❌ Sorry, I had trouble processing that. Please try `/ask` instead.').catch(() => {});
      }
    }
  });
}

// ─── /join ────────────────────────────────────────────────────────────────────
async function handleJoin(interaction) {
  const voiceChannel = interaction.member?.voice?.channel;
  if (!voiceChannel) {
    return interaction.reply({ content: '❌ Join a voice channel first!', ephemeral: true });
  }

  await interaction.reply(`✅ Joining **${voiceChannel.name}**! Say something 🎙️`);

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: interaction.guildId,
    adapterCreator: interaction.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
    debug: true,
  });

  // Log every state transition to diagnose failures in Railway logs
  connection.on('stateChange', (oldState, newState) => {
    console.log(`🔊 Voice state: ${oldState.status} → ${newState.status}`);
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch {
    const finalState = connection.state.status;
    console.error('❌ Voice timed out. Final state:', finalState);
    if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
      try { connection.destroy(); } catch {}
    }
    return interaction.followUp(`❌ Could not connect (state: ${finalState}). Check Railway logs.`);
  }

  try {
    const greetAudio = await synthesizeSpeech(
      "Hi there! I'm Aria, your AI assistant. Ask me anything!"
    );
    await playAudio(connection, greetAudio);
  } catch (err) {
    console.warn('Greeting audio failed (likely UDP blocked), sending text instead:', err.message);
    await interaction.channel.send("👋 **Aria:** Hi there! I'm Aria, your AI assistant. Ask me anything! *(Voice unavailable on this host — use `/ask` for text replies)*").catch(() => {});
  }

  // Store text channel for voice-triggered replies
  connection._textChannel = interaction.channel;
  connection.receiver.speaking.on('start', userId => {
    listenToUser(connection, userId, interaction.guildId, interaction.channel);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        try { connection.destroy(); } catch {}
      }
    }
  });
}

// ─── /leave ───────────────────────────────────────────────────────────────────
async function handleLeave(interaction) {
  const connection = getVoiceConnection(interaction.guildId);
  if (!connection) return interaction.reply({ content: "I'm not in a voice channel!", ephemeral: true });
  connection.destroy();
  interaction.reply('👋 Goodbye!');
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
    process.env.TTS_VOICE = voiceName;
    await interaction.reply(`✅ Voice changed to **${voiceName}**!`);
    const connection = getVoiceConnection(interaction.guildId);
    if (connection) await playAudio(connection, testAudio);
    else try { fs.unlinkSync(testAudio); } catch {}
  } catch {
    interaction.reply(`❌ Voice not found. Try: \`en-US-AriaNeural\`, \`en-US-JennyNeural\`, \`en-IN-NeerjaNeural\``);
  }
}

// ─── /clear ───────────────────────────────────────────────────────────────────
function handleClear(interaction) {
  delete conversationHistory[interaction.guildId];
  interaction.reply('🧹 Memory cleared!');
}

// ─── /imagine (Stable Horde — unlimited free) ────────────────────────────────
async function handleImagine(interaction) {
  await interaction.deferReply();

  const userPrompt = interaction.options.getString('prompt');
  const style      = interaction.options.getString('style') || '';
  const fullPrompt = style ? `${userPrompt}, ${style} style` : userPrompt;

  // Use user's key if set, otherwise anonymous (slower but still works)
  const HORDE_KEY  = process.env.STABLE_HORDE_KEY || '0000000000';

  try {
    await interaction.editReply('🎨 Submitting to Stable Horde, please wait...');

    // Step 1: Submit generation job
    const submitRes = await fetch('https://stablehorde.net/api/v2/generate/async', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': HORDE_KEY,
        'Client-Agent': 'discord-bot:1.0:anonymous',
      },
      body: JSON.stringify({
        prompt: fullPrompt,
        params: {
          width: 512,
          height: 512,
          steps: 30,
          cfg_scale: 7,
          sampler_name: 'k_euler_a',
          n: 1,
        },
        models: ['stable_diffusion'],
        r2: true,
      }),
    });

    if (!submitRes.ok) {
      const err = await submitRes.text();
      throw new Error(`Submit failed: ${err}`);
    }

    const { id } = await submitRes.json();
    if (!id) throw new Error('No job ID returned from Stable Horde');

    console.log(`🎨 Horde job submitted: ${id}`);

    // Step 2: Poll until done (max 3 minutes)
    let imageUrl = null;
    for (let i = 0; i < 36; i++) {
      await new Promise(r => setTimeout(r, 5000)); // wait 5s each poll

      const checkRes = await fetch(`https://stablehorde.net/api/v2/generate/status/${id}`, {
        headers: { 'Client-Agent': 'discord-bot:1.0:anonymous' },
      });

      if (!checkRes.ok) continue;
      const status = await checkRes.json();

      if (status.done && status.generations && status.generations.length > 0) {
        imageUrl = status.generations[0].img;
        break;
      }

      // Update message every 15s so user knows it's working
      if (i % 3 === 2) {
        const waited = (i + 1) * 5;
        await interaction.editReply(`🎨 Still generating... (${waited}s elapsed)`).catch(() => {});
      }
    }

    if (!imageUrl) throw new Error('Timed out waiting for image (3 min)');

    // Step 3: Fetch image and send to Discord
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) throw new Error('Could not download generated image');

    const arrayBuffer = await imgRes.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);

    const { AttachmentBuilder } = require('discord.js');
    const attachment = new AttachmentBuilder(imageBuffer, { name: 'imagine.png' });

    await interaction.editReply({
      content: `🎨 **Prompt:** ${userPrompt}${style ? `\n🖌️ **Style:** ${style}` : ''}`,
      files: [attachment],
    });

    console.log(`✅ /imagine done for: "${fullPrompt}"`);
  } catch (err) {
    console.error('❌ /imagine failed:', err.message);
    await interaction.editReply(`❌ Image generation failed: ${err.message}`);
  }
}

// ─── Interaction Router ───────────────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  switch (interaction.commandName) {
    case 'join':    return handleJoin(interaction);
    case 'leave':   return handleLeave(interaction);
    case 'ask':     return handleAsk(interaction);
    case 'voice':   return handleVoice(interaction);
    case 'clear':   return handleClear(interaction);
    case 'imagine': return handleImagine(interaction);
  }
});

// ─── Ready ────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  const aiProvider = GROQ_API_KEY ? 'Groq (free)' : 'OpenAI';
  console.log(`🤖 Aria is online as ${client.user.tag}`);
  console.log(`🎙️ Voice: ${TTS_VOICE}`);
  console.log(`🧠 AI provider: ${aiProvider}`);
  await registerCommands();
});

client.login(process.env.DISCORD_TOKEN);
