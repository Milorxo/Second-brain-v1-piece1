# Second Brain: version 1, piece 1

A private chat app that runs on your own computer. You talk to an AI (by typing or by voice), and every conversation is saved as plain files in a folder you own.

This first piece does three things:

1. Chat with the AI, as a normal thinking partner.
2. Save every conversation as plain text files.
3. Show your past conversations in a list so you can reopen them.

It cannot search or use your past conversations yet. That is the next piece. The full plan is in the design document.

---

## Set it up on your Mac (about 15 minutes, once)

### 1. Install Node.js

Node.js is the program that runs this app. You only install it once.

1. Go to **nodejs.org** and download the **LTS** version for macOS.
2. Open the downloaded file and follow the installer.
3. Open **Terminal** (press Command + Space, type `Terminal`, press Enter).
4. Type `node -v` and press Enter. If you see a number like `v22.x.x`, it worked. Any version 18 or higher is fine.

### 2. Put the app in a folder

Unzip the project and move the `second-brain` folder to your Documents folder. Keeping it in Documents means Time Machine backs it up automatically.

### 3. Get an API key

The app needs an AI account that you pay for by usage. This is separate from your Claude Pro subscription.

1. Go to **console.anthropic.com** and sign in or create an account.
2. Add a small amount of credit, and set a **monthly spending limit** so it can never cost more than you decide.
3. Create an API key and copy it. (Menu names on that site can change. Look for "API keys".)

Treat the key like a password. Never share it.

### 4. Give the app your key

In Terminal, run these three lines, one at a time:

```
cd ~/Documents/second-brain
cp .env.example .env
open -e .env
```

A text window opens. Replace `paste-your-key-here` with your key, then save and close.

### 5. Start the app

In Terminal, in that same folder:

```
node server.js
```

You should see "Second Brain is running". Open **http://localhost:3737** in Safari or Chrome.

To stop the app, go back to Terminal and press **Control + C**. The app only works while it is running.

---

## Using it

- **Enter** sends your message. **Shift + Enter** starts a new line.
- **Mic** starts voice input (English). Press it again to stop, then press Send. Your browser will ask for microphone permission the first time. Chrome and Safari support it. Some browsers send the audio to a cloud service to turn it into text, so use the Mic only when you are comfortable with that.
- **New** starts a fresh conversation. Past conversations are listed on the left.
- If the AI fails or your internet is down, your message is **still saved**. Nothing you write is lost.

## Where your data is

Everything is in the `memory` folder inside the app folder:

```
memory/conversations/2026-10-09_2355_ab12.md      readable copy
memory/conversations/2026-10-09_2355_ab12.jsonl   exact record (the source of truth)
```

You can open the `.md` files in any text editor. **Back up the `memory` folder.** It is the one thing in here that cannot be recreated.

## Settings

- `config.json`: the AI model name, reply length, the memory folder, and the port. If you change the model, use a model name from Anthropic's documentation.
- `prompts/system.md`: how the AI behaves. You can edit it in any text editor. Changes apply on the next message, with no restart.
- `.env`: your API key only.

## Using it like an app

While the app is running, in Safari (macOS Sonoma or newer) you can choose **File, then Add to Dock** to get an app icon that opens it in its own window. A full install button for Chrome, and phone access, come in a later piece.

## Check that it works (optional)

```
node test.js
```

This runs 18 checks against a fake AI and a temporary folder. It does not use your key or touch your memory.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| `command not found: node` | Node.js is not installed. Repeat step 1, then open a new Terminal window. |
| A yellow banner: "No API key found" | Check that the file is named exactly `.env`, sits next to `server.js`, and contains `ANTHROPIC_API_KEY=` followed by your key. Then restart the app. |
| "Port 3737 is already in use" | Another copy is running. Close it, or change `port` in `config.json`. |
| An error from the AI service with a number | Read the message. Common causes are no credit left, a wrong key, or a wrong model name. |
| The Mic button is missing | Your browser has no speech recognition. Use Safari or Chrome. |

## Privacy

- The app listens only on your own computer. Other devices and other websites cannot reach it.
- Your key stays in the app. It is never sent to the web page.
- Each message sends only the current conversation to the AI service. Nothing else on your computer is sent.
- Do not share `.env` or the `memory` folder.
