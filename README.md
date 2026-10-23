# AI Voice Assistant

A ChatGPT-style chatbot that runs **fully on your own computer**. Type or speak a question, get an answer from a real local language model (via [Ollama](https://ollama.com)), and have it read aloud.

View my deployed Project : https://ai-chatbot-2-v3g0.onrender.com

## Features

- Real AI answers from a local LLM (default `llama3.2:3b`), no paid API or API key
- Conversation memory: follow-up questions like "Give me an example" work
- **Attach photos and files** (paperclip, drag & drop, or paste with Ctrl+V): the AI can describe/read images, and read PDF, DOCX, TXT, code, CSV files
- Voice input (microphone button) using the browser Web Speech API
- Voice output (text-to-speech) with Stop Speaking and per-message replay
- Chat history sidebar (new, open, delete chats) saved in browser localStorage
- Safe Markdown rendering: paragraphs, bullet lists, code blocks (HTML is escaped)
- Copy button, timestamps, typing indicator, duplicate-send protection
- Friendly error messages (Ollama off, model missing, mic denied, etc.)
- Responsive dark UI that works on desktop and mobile widths

## Technologies Used

| Layer | Technology |
|---|---|
| Frontend | HTML5, CSS3, vanilla JavaScript, Fetch API |
| Voice | Web Speech API (SpeechRecognition + SpeechSynthesis) |
| Backend | Python 3, Flask, Requests |
| AI | Ollama + llama3.2:3b (text) and llava (images) |
| Files | pypdf (PDF), python-docx (DOCX) |

## Architecture

```
Browser (HTML/CSS/JS)
  |  mic -> SpeechRecognition -> text
  |  POST /api/chat  { message, history }
  v
Flask (app.py)  -- validates input, builds the message list
  |  POST http://localhost:11434/api/chat
  v
Ollama (local model)  -> reply -> Flask -> JSON { reply } -> Browser
  |  SpeechSynthesis reads the reply aloud
```

The browser keeps the chat history and sends the previous messages with every request. This is how the model remembers the conversation.

## Project Structure

```
AI-Chatbot/
├── app.py              # Flask server and Ollama integration
├── requirements.txt    # Python dependencies
├── README.md
├── .gitignore
├── templates/
│   └── index.html      # Page layout
└── static/
    ├── style.css       # Styling
    └── script.js       # Chat, history, voice input/output
```

## Prerequisites

- Windows 11 (macOS/Linux also work)
- Python 3.9 or newer
- About 8 GB RAM recommended; roughly 3 GB free disk space for the model
- Google Chrome or Microsoft Edge (needed for voice input)

## Installation

### 1. Install Ollama
Download from https://ollama.com/download, run the installer, and keep Ollama running (it starts in the system tray).

### 2. Download the model
```
ollama pull llama3.2:3b
```
Check it is installed with `ollama list`.

### 2b. Download the vision model (needed only for photos)
```
ollama pull llava
```
`llama3.2:3b` cannot see images, so the app automatically switches to `llava` when you attach a photo.
On a slow laptop use the lighter model instead: `ollama pull moondream`, then set `OLLAMA_VISION_MODEL=moondream` before running.

### 3. Create a virtual environment
```
python --version
python -m venv .venv
.venv\Scripts\activate
```

### 4. Install dependencies
```
pip install -r requirements.txt
```

## Run the Project

```
python app.py
```
Open **http://127.0.0.1:5000** in Chrome or Edge.

Optional settings (PowerShell): `$env:OLLAMA_MODEL="llama3.2:1b"` before `python app.py` to use a different model.

## How to Use Voice Input

1. Click the microphone button and allow microphone access.
2. The button turns red and "Listening..." appears.
3. Speak your question. When you stop, the text is sent automatically.
4. Chrome and Edge send audio to their speech service, so an internet connection is required for voice input.

## How Text-to-Speech Works

Replies are passed to the browser's `SpeechSynthesis` API, which speaks them using voices installed on your system. Long replies are split into sentence chunks so browsers do not cut them off. Use **Stop speaking** (top bar) or the stop icon under any reply. Turn off **Auto-read** to disable automatic speech.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Cannot reach Ollama" | Open the Ollama app from the Start menu; check http://localhost:11434 |
| "Model not installed" | Run `ollama pull llama3.2:3b` |
| Very slow replies | Use a smaller model, e.g. `ollama pull llama3.2:1b` and set `OLLAMA_MODEL` |
| Microphone does nothing | Use Chrome/Edge, open via `127.0.0.1` or `localhost`, allow mic permission |
| No voice output | Check system volume; try Chrome/Edge; click the speaker icon on a reply |
| `python` not found | Reinstall Python and tick "Add Python to PATH" |
| Port 5000 busy | Change the port in the last line of `app.py` |

## Future Improvements

- Streaming responses (token by token)
- User accounts and a database (SQLite/PostgreSQL) for history
- Model selector in the UI
- Docker setup and automated tests (pytest)
- Document Q&A with retrieval (RAG)
- Multi-language voice input and output

## Skills Demonstrated

REST API design with Flask, integrating a local LLM, async JavaScript (Fetch), browser APIs (Speech, localStorage, Clipboard), input validation, XSS-safe rendering, Content-Security-Policy headers, error handling, responsive CSS, and clean project structure.


## Author

Supriya Tiwari  - Computer Engineering student
GitHub: https://github.com/ | LinkedIn: www.linkedin.com/in/supriya-tiwari02

## Attachments (photos and files)

- Click the paperclip, drag files onto the page, or paste a screenshot with Ctrl+V
- Photos: up to 4 per message (resized in the browser before sending). Answered by the vision model
- Files: up to 3 per message, PDF / DOCX / TXT / MD / CSV / JSON / code. Only the first ~12,000 characters are sent (small models have small memory)
- Scanned (image-only) PDFs cannot be read; attach them as photos instead
- Photos are kept in memory only; after a page refresh the chat shows a thumbnail but the AI can no longer re-see the original
- Environment variables: `OLLAMA_VISION_MODEL` (default `llava`), `GROQ_VISION_MODEL` for cloud mode
