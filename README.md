# 🎙️ Discord Voice AI Bot (Aria) — FREE Version
**Railway-ready** | **No credit card needed** | **No Azure needed**

Uses **edge-tts** (Microsoft Neural voices, completely free) + **ChatGPT** for answers.

---

## ✅ What you need (all free)
| What | Where | Credit Card? |
|---|---|---|
| Discord Bot Token | discord.com/developers | ❌ No |
| OpenAI API Key | platform.openai.com | ❌ No (free tier available) |
| Railway account | railway.app | ❌ No (free $5/month credit) |
| Azure / TTS API | ~~required~~ | ✅ NOT NEEDED |

---

## 🚀 Deploy to Railway

### Step 1 — Get Discord Bot Token + Client ID
1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application** → name it (e.g. "Aria")
3. Go to **Bot** tab → **Add Bot** → copy **Token**
4. Enable these intents: ✅ Server Members Intent, ✅ Message Content Intent
5. Go to **OAuth2** tab → copy **Client ID**
6. Invite bot to your server:
   ```
   https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=3148800&scope=bot%20applications.commands
   ```

### Step 2 — Get OpenAI API Key (free)
1. Go to [platform.openai.com](https://platform.openai.com) → Sign up (email only, no CC for basic use)
2. Go to **API Keys** → Create key → copy it

### Step 3 — Deploy to Railway
1. Push code to GitHub:
   ```bash
   git init && git add . && git commit -m "Aria bot"
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select your repo → go to **Variables** tab → add:

   | Variable | Value |
   |---|---|
   | `DISCORD_TOKEN` | your bot token |
   | `DISCORD_CLIENT_ID` | your client ID |
   | `OPENAI_API_KEY` | your OpenAI key |
   | `TTS_VOICE` | `en-US-JennyNeural` |

4. Railway auto-deploys ✅ Done!

---

## 💬 Commands
| Command | What it does |
|---|---|
| `/join` | Bot joins your voice channel |
| `/leave` | Bot leaves |
| `/ask [question]` | Ask via text (no mic needed) |
| `/voice [name]` | Change Aria's voice live |
| `/clear` | Reset memory |

---

## 🎤 Free Female Voices (no API key needed)
| Voice | Style |
|---|---|
| `en-US-JennyNeural` | Warm, friendly (default) |
| `en-US-AriaNeural` | Natural, expressive |
| `en-US-MichelleNeural` | Clear, professional |
| `en-US-AnaNeural` | Cheerful, young |
| `en-IN-NeerjaNeural` | Indian English |
| `en-GB-SoniaNeural` | British English |

Switch with: `/voice en-US-AriaNeural`

---

## 💰 Total Cost: $0
- Discord Bot: Free
- edge-tts: Free (no account needed)
- Railway: Free $5/month credit
- OpenAI: Free tier for small usage
