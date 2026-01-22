#!/usr/bin/env node
'use strict';

// ============================================================================
// 🤖 AI CHAT PLATFORM - BotHost.ru Edition
// ============================================================================

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');

// Config
const CONFIG = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_BOT_USERNAME: process.env.TELEGRAM_BOT_USERNAME || '',
  PORT: process.env.PORT || 3000,
  DOMAIN: process.env.DOMAIN || 'http://localhost:3000',
  JWT_SECRET: process.env.JWT_SECRET || 'default_secret_key',
  GOOGLE_AI_KEY: process.env.GOOGLE_AI_KEY || ''
};

if (!CONFIG.TELEGRAM_BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN not set!');
  process.exit(1);
}

console.log('✅ Starting AI Platform...');
console.log('📱 Bot:', CONFIG.TELEGRAM_BOT_USERNAME);
console.log('🌐 Domain:', CONFIG.DOMAIN);

// Database
const db = new Database('data.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL,
    first_name TEXT,
    plan TEXT DEFAULT 'free',
    daily_limit INTEGER DEFAULT 100,
    used_today INTEGER DEFAULT 0,
    total_messages INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT DEFAULT 'Новый чат',
    model TEXT DEFAULT 'gemini-pro',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

console.log('✅ Database ready');

const db_users = {
  get: db.prepare('SELECT * FROM users WHERE telegram_id = ?'),
  create: db.prepare('INSERT INTO users (telegram_id, username, first_name) VALUES (?, ?, ?)'),
  update: db.prepare('UPDATE users SET used_today = used_today + 1 WHERE id = ?'),
  reset: db.prepare('UPDATE users SET used_today = 0 WHERE date(created_at) < date("now")')
};

const db_chats = {
  list: db.prepare('SELECT * FROM chats WHERE user_id = ? ORDER BY id DESC LIMIT 20'),
  create: db.prepare('INSERT INTO chats (user_id, title, model) VALUES (?, ?, ?)'),
  get: db.prepare('SELECT * FROM chats WHERE id = ? AND user_id = ?')
};

const db_messages = {
  list: db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY id ASC'),
  create: db.prepare('INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)')
};

// AI Service
class AI {
  async chat(messages) {
    if (!CONFIG.GOOGLE_AI_KEY) {
      return 'Привет! 👋 Я AI ассистент. Для полноценной работы настройте Google AI API ключ в переменных окружения BotHost.\n\nКак получить ключ:\n1. Перейдите на https://makersuite.google.com/app/apikey\n2. Создайте API ключ\n3. Добавьте в переменные: GOOGLE_AI_KEY';
    }

    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${CONFIG.GOOGLE_AI_KEY}`,
        {
          contents: messages.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
          }))
        },
        { timeout: 30000 }
      );
      return res.data.candidates[0].content.parts[0].text;
    } catch (e) {
      console.error('AI Error:', e.message);
      return 'Извините, произошла ошибка при генерации ответа. Проверьте API ключ или попробуйте позже.';
    }
  }
}

const ai = new AI();
console.log('✅ AI ready');

// Telegram Bot
let bot;
const authRequests = new Map();

try {
  bot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { polling: true });
  console.log('✅ Telegram bot started');

  bot.on('polling_error', (e) => console.error('⚠️ Polling:', e.message));

  bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const code = match[1].trim();
    
    if (code && authRequests.has(code)) {
      let user = db_users.get.get(msg.from.id.toString());
      if (!user) {
        db_users.create.run(
          msg.from.id.toString(),
          msg.from.username || 'user_' + msg.from.id,
          msg.from.first_name || 'User'
        );
        user = db_users.get.get(msg.from.id.toString());
      }
      
      const token = jwt.sign({ userId: user.id, tid: user.telegram_id }, CONFIG.JWT_SECRET, { expiresIn: '7d' });
      authRequests.get(code).resolve({ success: true, token, user });
      authRequests.delete(code);
      
      await bot.sendMessage(chatId, '✅ Авторизация успешна! Возвращайтесь на сайт.');
    } else {
      await bot.sendMessage(chatId, 
        '🎉 Добро пожаловать в AI Platform!\n\n' +
        '🤖 Доступные модели:\n' +
        '🟢 Google Gemini Pro\n\n' +
        '📱 Откройте платформу: ' + CONFIG.DOMAIN,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: '🚀 Открыть платформу', url: CONFIG.DOMAIN }
            ]]
          }
        }
      );
    }
  });
} catch (e) {
  console.error('❌ Bot error:', e.message);
}

// Web Server
const app = express();
app.use(express.json());
app.use(require('cors')());

const auth = (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'No token' });
    const decoded = jwt.verify(token, CONFIG.JWT_SECRET);
    const user = db_users.get.get(decoded.tid);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// API
app.get('/health', (req, res) => {
  res.json({ status: 'ok', bot: bot ? 'online' : 'offline' });
});

app.post('/api/auth/init', async (req, res) => {
  const code = uuidv4();
  const url = `https://t.me/${CONFIG.TELEGRAM_BOT_USERNAME}?start=${code}`;
  authRequests.set(code, { resolve: () => {}, ts: Date.now() });
  setTimeout(() => authRequests.delete(code), 300000);
  const qr = await QRCode.toDataURL(url);
  res.json({ success: true, authCode: code, telegramUrl: url, qrCode: qr });
});

app.get('/api/auth/status/:code', async (req, res) => {
  const { code } = req.params;
  if (!authRequests.has(code)) {
    return res.json({ success: false, status: 'expired' });
  }
  
  try {
    const result = await Promise.race([
      new Promise(resolve => {
        authRequests.get(code).resolve = resolve;
      }),
      new Promise(resolve => setTimeout(() => resolve({ status: 'pending' }), 30000))
    ]);
    res.json(result.success ? result : { success: false, status: 'pending' });
  } catch (e) {
    res.json({ success: false, status: 'error' });
  }
});

app.get('/api/auth/verify', auth, (req, res) => {
  res.json({ success: true, user: req.user });
});

app.get('/api/chat', auth, (req, res) => {
  const chats = db_chats.list.all(req.user.id);
  res.json({ success: true, chats });
});

app.post('/api/chat', auth, (req, res) => {
  const info = db_chats.create.run(req.user.id, 'Новый чат', 'gemini-pro');
  const chat = { id: info.lastInsertRowid, title: 'Новый чат' };
  res.json({ success: true, chat });
});

app.get('/api/chat/:id/messages', auth, (req, res) => {
  const chat = db_chats.get.get(req.params.id, req.user.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  const messages = db_messages.list.all(req.params.id);
  res.json({ success: true, messages });
});

app.post('/api/chat/:id/message', auth, async (req, res) => {
  const { content } = req.body;
  const chat = db_chats.get.get(req.params.id, req.user.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  
  db_users.reset.run();
  const user = db_users.get.get(req.user.telegram_id);
  if (user.used_today >= user.daily_limit) {
    return res.status(429).json({ error: 'Daily limit reached' });
  }
  
  db_messages.create.run(req.params.id, 'user', content);
  const userMsg = { role: 'user', content };
  
  const history = db_messages.list.all(req.params.id).map(m => ({ role: m.role, content: m.content }));
  const aiReply = await ai.chat(history);
  
  db_messages.create.run(req.params.id, 'assistant', aiReply);
  db_users.update.run(user.id);
  
  const assistantMsg = { role: 'assistant', content: aiReply };
  res.json({ success: true, userMessage: userMsg, assistantMessage: assistantMsg });
});

// HTML
const HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Platform</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
body{background:linear-gradient(135deg,#0f172a,#1e293b);font-family:system-ui;min-height:100vh;color:#fff}
.glass{background:rgba(30,41,59,0.7);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.1)}
.gradient{background:linear-gradient(-45deg,#6366f1,#8b5cf6,#06b6d4,#3b82f6);background-size:400% 400%;animation:g 15s ease infinite}
@keyframes g{0%,100%{background-position:0 50%}50%{background-position:100% 50%}}
.typing{animation:t 1.4s infinite}
@keyframes t{0%,100%{opacity:0.2}50%{opacity:1}}
</style>
</head>
<body>
<div id="auth" class="fixed inset-0 z-50 flex items-center justify-center bg-black/90">
<div class="glass rounded-2xl p-8 max-w-md w-full mx-4">
<div class="text-center space-y-6">
<div class="w-20 h-20 gradient rounded-2xl mx-auto"></div>
<h2 class="text-2xl font-bold">Вход через Telegram</h2>
<div id="authContent">
<div id="loading" class="hidden">
<div class="flex justify-center space-x-2 mb-4">
<div class="w-3 h-3 bg-indigo-500 rounded-full typing"></div>
<div class="w-3 h-3 bg-purple-500 rounded-full typing" style="animation-delay:0.2s"></div>
<div class="w-3 h-3 bg-cyan-500 rounded-full typing" style="animation-delay:0.4s"></div>
</div>
<p class="text-gray-400">Ожидание...</p>
</div>
<div id="btn">
<a id="link" href="#" target="_blank" class="block w-full py-4 bg-blue-600 hover:bg-blue-500 rounded-xl font-semibold">Войти</a>
</div>
<div id="qr" class="hidden mt-4">
<img id="qrimg" class="mx-auto bg-white p-4 rounded-xl max-w-[200px]"/>
</div>
</div>
</div>
</div>
</div>

<div id="app" class="hidden h-screen flex flex-col">
<div class="glass border-b border-white/10 p-4">
<div class="max-w-4xl mx-auto flex justify-between items-center">
<div class="flex items-center space-x-3">
<div class="w-10 h-10 gradient rounded-lg"></div>
<h1 class="font-bold">AI Platform</h1>
</div>
<button onclick="logout()" class="px-4 py-2 glass rounded-lg hover:bg-white/10">Выйти</button>
</div>
</div>

<div id="msgs" class="flex-1 overflow-y-auto p-4">
<div class="max-w-4xl mx-auto">
<div class="text-center py-20">
<div class="w-20 h-20 gradient rounded-2xl mx-auto mb-6"></div>
<h2 class="text-3xl font-bold mb-4">Задайте вопрос AI</h2>
</div>
</div>
</div>

<div class="glass border-t border-white/10 p-4">
<div class="max-w-4xl mx-auto flex space-x-3">
<textarea id="input" rows="1" placeholder="Сообщение..." class="flex-1 glass rounded-2xl p-3 resize-none focus:outline-none bg-transparent" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();send()}"></textarea>
<button onclick="send()" class="px-6 py-3 gradient rounded-xl font-semibold">→</button>
</div>
</div>
</div>

<script>
let token=localStorage.getItem('token');
let user,chatId;

async function init(){
if(token){
const r=await fetch('/api/auth/verify',{headers:{'Authorization':'Bearer '+token}});
const d=await r.json();
if(d.success){user=d.user;showApp();return}
}
document.getElementById('auth').classList.remove('hidden');
const r=await fetch('/api/auth/init',{method:'POST'});
const d=await r.json();
document.getElementById('link').href=d.telegramUrl;
document.getElementById('qrimg').src=d.qrCode;
document.getElementById('qr').classList.remove('hidden');
poll(d.authCode);
}

async function poll(code){
document.getElementById('btn').classList.add('hidden');
document.getElementById('loading').classList.remove('hidden');
let i=0;
const check=async()=>{
if(i++>=60)return alert('Время истекло');
const r=await fetch('/api/auth/status/'+code);
const d=await r.json();
if(d.success&&d.token){
token=d.token;user=d.user;
localStorage.setItem('token',token);
showApp();
}else if(d.status==='expired'){
alert('Код истёк');
}else setTimeout(check,5000);
};
check();
}

function showApp(){
document.getElementById('auth').classList.add('hidden');
document.getElementById('app').classList.remove('hidden');
loadChat();
}

function logout(){
localStorage.removeItem('token');
location.reload();
}

async function loadChat(){
const r=await fetch('/api/chat',{headers:{'Authorization':'Bearer '+token}});
const d=await r.json();
if(d.chats.length>0){
chatId=d.chats[0].id;
const r2=await fetch('/api/chat/'+chatId+'/messages',{headers:{'Authorization':'Bearer '+token}});
const d2=await r2.json();
const c=document.getElementById('msgs');
c.innerHTML='<div class="max-w-4xl mx-auto space-y-4"></div>';
d2.messages.forEach(m=>add(m.role,m.content));
}else{
const r2=await fetch('/api/chat',{method:'POST',headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'}});
const d2=await r2.json();
chatId=d2.chat.id;
}
}

function add(role,text){
let c=document.getElementById('msgs').querySelector('div');
if(!c){
document.getElementById('msgs').innerHTML='<div class="max-w-4xl mx-auto space-y-4"></div>';
c=document.getElementById('msgs').querySelector('div');
}
const div=document.createElement('div');
div.className=role==='user'?'flex justify-end':'flex';
div.innerHTML=role==='user'?'<div class="max-w-2xl px-6 py-4 gradient rounded-2xl">'+esc(text)+'</div>':'<div class="max-w-2xl px-6 py-4 glass rounded-2xl">'+fmt(text)+'</div>';
c.appendChild(div);
c.scrollIntoView({behavior:'smooth',block:'end'});
}

async function send(){
const input=document.getElementById('input');
const text=input.value.trim();
if(!text)return;
add('user',text);
input.value='';
const typing=addTyping();
try{
const r=await fetch('/api/chat/'+chatId+'/message',{
method:'POST',
headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},
body:JSON.stringify({content:text})
});
const d=await r.json();
typing.remove();
if(d.success){
add('assistant',d.assistantMessage.content);
}else{
alert(d.error||'Ошибка');
}
}catch(e){
typing.remove();
alert('Ошибка: '+e.message);
}
}

function addTyping(){
const c=document.getElementById('msgs').querySelector('div');
const div=document.createElement('div');
div.id='typing';
div.innerHTML='<div class="px-6 py-4 glass rounded-2xl">AI думает...</div>';
c.appendChild(div);
return div;
}

function esc(t){
const div=document.createElement('div');
div.textContent=t;
return div.innerHTML;
}

function fmt(t){
return t.replace(/\\*\\*(.*?)\\*\\*/g,'<strong>$1</strong>').replace(/\\n/g,'<br>');
}

init();
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(HTML));
app.get('*', (req, res) => res.send(HTML));

// Start
app.listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════╗
║  🤖 AI PLATFORM STARTED           ║
║  🌐 Port: ${CONFIG.PORT}                     ║
║  📱 Bot: ${CONFIG.TELEGRAM_BOT_USERNAME}     
║  🔗 ${CONFIG.DOMAIN}
╚════════════════════════════════════╝
  `);
});

process.on('SIGTERM', () => {
  if (bot) bot.stopPolling();
  db.close();
  process.exit(0);
});
