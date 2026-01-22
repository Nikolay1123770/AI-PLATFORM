#!/usr/bin/env node
'use strict';

// ============================================================================
// 🤖 AI CHAT PLATFORM - BotHost.ru Edition v2
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
    last_reset DATE DEFAULT (date('now')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT DEFAULT 'Новый чат',
    model TEXT DEFAULT 'gemini-pro',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chat_id) REFERENCES chats(id)
  );
`);

console.log('✅ Database ready');

// Database helpers
const db_users = {
  get: db.prepare('SELECT * FROM users WHERE telegram_id = ?'),
  create: db.prepare('INSERT INTO users (telegram_id, username, first_name) VALUES (?, ?, ?)'),
  incrementUsage: db.prepare('UPDATE users SET used_today = used_today + 1, total_messages = total_messages + 1 WHERE id = ?'),
  resetDaily: db.prepare(`UPDATE users SET used_today = 0, last_reset = date('now') WHERE date(last_reset) < date('now')`)
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
      return '👋 Привет! Я AI ассистент.\n\n' +
             '⚠️ Для полноценной работы нужен Google AI API ключ.\n\n' +
             '📝 Как настроить:\n' +
             '1. Перейдите на https://makersuite.google.com/app/apikey\n' +
             '2. Создайте бесплатный API ключ\n' +
             '3. В настройках бота на BotHost добавьте переменную:\n' +
             '   GOOGLE_AI_KEY = ваш_ключ\n' +
             '4. Перезапустите бота\n\n' +
             '✨ После этого я смогу отвечать на любые вопросы!';
    }

    try {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${CONFIG.GOOGLE_AI_KEY}`,
        {
          contents: messages.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
          })),
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 2048
          }
        },
        { 
          timeout: 30000,
          headers: { 'Content-Type': 'application/json' }
        }
      );

      return response.data.candidates[0].content.parts[0].text;
    } catch (error) {
      console.error('❌ AI Error:', error.message);
      
      if (error.response?.status === 401 || error.response?.status === 403) {
        return '❌ Ошибка API ключа. Проверьте правильность GOOGLE_AI_KEY в настройках.';
      }
      
      if (error.response?.status === 429) {
        return '⏳ Превышен лимит запросов. Подождите немного и попробуйте снова.';
      }
      
      return '⚠️ Произошла ошибка при генерации ответа. Попробуйте позже или проверьте настройки API.';
    }
  }
}

const ai = new AI();
console.log('✅ AI Service ready');

// Telegram Bot
let bot;
const authRequests = new Map();

try {
  bot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN, { 
    polling: { 
      interval: 1000,
      autoStart: true 
    } 
  });
  
  console.log('✅ Telegram bot started');

  bot.on('polling_error', (error) => {
    console.error('⚠️ Polling error:', error.message);
  });

  bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const code = match[1].trim();
    
    try {
      if (code && authRequests.has(code)) {
        // Web auth
        let user = db_users.get.get(msg.from.id.toString());
        
        if (!user) {
          db_users.create.run(
            msg.from.id.toString(),
            msg.from.username || 'user_' + msg.from.id,
            msg.from.first_name || 'User'
          );
          user = db_users.get.get(msg.from.id.toString());
        }
        
        const token = jwt.sign(
          { userId: user.id, tid: user.telegram_id }, 
          CONFIG.JWT_SECRET, 
          { expiresIn: '7d' }
        );
        
        authRequests.get(code).resolve({ success: true, token, user });
        authRequests.delete(code);
        
        await bot.sendMessage(chatId, 
          '✅ <b>Авторизация успешна!</b>\n\n' +
          'Теперь можете вернуться на сайт и начать общение с AI.',
          { parse_mode: 'HTML' }
        );
      } else {
        // Normal start
        await bot.sendMessage(chatId, 
          '🎉 <b>Добро пожаловать в AI Platform!</b>\n\n' +
          '🤖 <b>Доступные модели:</b>\n' +
          '🟢 Google Gemini Pro (бесплатно)\n\n' +
          '📱 Откройте веб-платформу для общения с AI:\n' +
          CONFIG.DOMAIN + '\n\n' +
          '💡 <b>Как начать:</b>\n' +
          '1. Откройте сайт\n' +
          '2. Нажмите "Войти через Telegram"\n' +
          '3. Подтвердите авторизацию в боте\n' +
          '4. Начните диалог!',
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[
                { text: '🚀 Открыть AI Platform', url: CONFIG.DOMAIN }
              ]]
            }
          }
        );
      }
    } catch (error) {
      console.error('❌ /start error:', error);
      await bot.sendMessage(chatId, '❌ Произошла ошибка. Попробуйте /start снова.');
    }
  });

  bot.on('message', async (msg) => {
    // Handle other commands if needed
  });

} catch (error) {
  console.error('❌ Failed to start Telegram bot:', error);
}

// Express Web Server
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(require('cors')({ origin: '*' }));

// Auth Middleware
const auth = (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    const decoded = jwt.verify(token, CONFIG.JWT_SECRET);
    const user = db_users.get.get(decoded.tid);
    
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    
    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// API Routes
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    bot: bot ? 'online' : 'offline',
    timestamp: new Date().toISOString()
  });
});

app.post('/api/auth/init', async (req, res) => {
  try {
    const code = uuidv4();
    const url = `https://t.me/${CONFIG.TELEGRAM_BOT_USERNAME}?start=${code}`;
    
    authRequests.set(code, { 
      resolve: () => {}, 
      timestamp: Date.now() 
    });
    
    // Auto cleanup after 5 minutes
    setTimeout(() => authRequests.delete(code), 300000);
    
    const qr = await QRCode.toDataURL(url);
    
    res.json({ 
      success: true, 
      authCode: code, 
      telegramUrl: url, 
      qrCode: qr 
    });
  } catch (error) {
    console.error('❌ Auth init error:', error);
    res.status(500).json({ error: 'Failed to initialize auth' });
  }
});

app.get('/api/auth/status/:code', async (req, res) => {
  const { code } = req.params;
  
  if (!authRequests.has(code)) {
    return res.json({ success: false, status: 'expired' });
  }
  
  try {
    const result = await Promise.race([
      new Promise((resolve) => {
        authRequests.get(code).resolve = resolve;
      }),
      new Promise((resolve) => 
        setTimeout(() => resolve({ status: 'pending' }), 30000)
      )
    ]);
    
    res.json(result.success ? result : { success: false, status: 'pending' });
  } catch (error) {
    res.json({ success: false, status: 'error' });
  }
});

app.get('/api/auth/verify', auth, (req, res) => {
  res.json({ success: true, user: req.user });
});

app.get('/api/chat', auth, (req, res) => {
  try {
    const chats = db_chats.list.all(req.user.id);
    res.json({ success: true, chats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/chat', auth, (req, res) => {
  try {
    const { title = 'Новый чат', model = 'gemini-pro' } = req.body;
    const info = db_chats.create.run(req.user.id, title, model);
    const chat = db_chats.get.get(info.lastInsertRowid, req.user.id);
    res.json({ success: true, chat });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/chat/:id/messages', auth, (req, res) => {
  try {
    const chat = db_chats.get.get(req.params.id, req.user.id);
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }
    
    const messages = db_messages.list.all(req.params.id);
    res.json({ success: true, messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/chat/:id/message', auth, async (req, res) => {
  try {
    const { content } = req.body;
    
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Message content is required' });
    }
    
    // Check chat exists
    const chat = db_chats.get.get(req.params.id, req.user.id);
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }
    
    // Reset daily limits if needed
    db_users.resetDaily.run();
    
    // Check limits
    const user = db_users.get.get(req.user.telegram_id);
    if (user.used_today >= user.daily_limit) {
      return res.status(429).json({ 
        error: 'Daily limit reached',
        limit: user.daily_limit,
        used: user.used_today
      });
    }
    
    // Save user message
    db_messages.create.run(req.params.id, 'user', content);
    const userMessage = { role: 'user', content };
    
    // Get chat history
    const history = db_messages.list.all(req.params.id).map(m => ({
      role: m.role,
      content: m.content
    }));
    
    // Generate AI response
    const aiReply = await ai.chat(history);
    
    // Save AI message
    db_messages.create.run(req.params.id, 'assistant', aiReply);
    const assistantMessage = { role: 'assistant', content: aiReply };
    
    // Update user stats
    db_users.incrementUsage.run(user.id);
    
    res.json({ 
      success: true, 
      userMessage, 
      assistantMessage 
    });
    
  } catch (error) {
    console.error('❌ Message error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/models', (req, res) => {
  res.json({
    success: true,
    models: [
      {
        id: 'gemini-pro',
        name: 'Google Gemini Pro',
        description: 'Мощная мультимодальная модель от Google',
        free: true,
        active: !!CONFIG.GOOGLE_AI_KEY
      }
    ]
  });
});

// Frontend HTML
const HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Chat Platform</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
body{background:linear-gradient(135deg,#0f172a,#1e293b);font-family:system-ui;min-height:100vh;color:#fff;margin:0;padding:0}
.glass{background:rgba(30,41,59,0.8);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.1)}
.gradient{background:linear-gradient(-45deg,#6366f1,#8b5cf6,#06b6d4,#3b82f6);background-size:400% 400%;animation:g 15s ease infinite}
@keyframes g{0%,100%{background-position:0 50%}50%{background-position:100% 50%}}
.typing{animation:t 1.4s infinite}
.typing:nth-child(2){animation-delay:0.2s}
.typing:nth-child(3){animation-delay:0.4s}
@keyframes t{0%,100%{opacity:0.2}50%{opacity:1}}
::-webkit-scrollbar{width:8px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:#4b5563;border-radius:4px}
</style>
</head>
<body>

<div id="auth" class="fixed inset-0 z-50 flex items-center justify-center bg-black/90">
<div class="glass rounded-2xl p-8 max-w-md w-full mx-4">
<div class="text-center space-y-6">
<div class="w-20 h-20 gradient rounded-2xl mx-auto flex items-center justify-center">
<svg class="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
</div>
<h2 class="text-2xl font-bold">Вход через Telegram</h2>
<p class="text-gray-400 text-sm">Авторизуйтесь для доступа к AI</p>
<div id="authContent">
<div id="loading" class="hidden">
<div class="flex justify-center space-x-2 mb-4">
<div class="w-3 h-3 bg-indigo-500 rounded-full typing"></div>
<div class="w-3 h-3 bg-purple-500 rounded-full typing"></div>
<div class="w-3 h-3 bg-cyan-500 rounded-full typing"></div>
</div>
<p class="text-gray-400 text-sm">Ожидание подтверждения...</p>
</div>
<div id="btn">
<a id="link" href="#" target="_blank" class="block w-full py-4 bg-blue-600 hover:bg-blue-500 rounded-xl font-semibold transition">Войти через Telegram</a>
<p class="text-xs text-gray-500 mt-3">Нажмите и подтвердите в боте</p>
</div>
<div id="qr" class="hidden mt-4">
<img id="qrimg" class="mx-auto bg-white p-3 rounded-xl" style="max-width:200px"/>
<p class="text-xs text-gray-400 mt-2">Или отсканируйте QR-код</p>
</div>
</div>
</div>
</div>
</div>

<div id="app" class="hidden h-screen flex flex-col">
<div class="glass border-b border-white/10 p-4">
<div class="max-w-5xl mx-auto flex justify-between items-center">
<div class="flex items-center space-x-3">
<div class="w-10 h-10 gradient rounded-lg flex items-center justify-center">
<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
</div>
<div>
<h1 class="font-bold text-lg">AI Platform</h1>
<p class="text-xs text-gray-400" id="userInfo">Загрузка...</p>
</div>
</div>
<button onclick="logout()" class="px-4 py-2 glass rounded-lg hover:bg-white/10 transition text-sm">Выйти</button>
</div>
</div>

<div id="msgs" class="flex-1 overflow-y-auto p-4">
<div class="max-w-4xl mx-auto">
<div class="text-center py-20">
<div class="w-24 h-24 gradient rounded-3xl mx-auto mb-6 flex items-center justify-center">
<svg class="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/></svg>
</div>
<h2 class="text-4xl font-bold mb-3">Задайте любой вопрос</h2>
<p class="text-gray-400 mb-8">Начните диалог с AI ассистентом</p>
<div class="grid md:grid-cols-2 gap-4 max-w-2xl mx-auto">
<button onclick="ask('Объясни квантовую физику простыми словами')" class="p-4 glass rounded-xl text-left hover:bg-white/5 transition">
<div class="font-semibold mb-1">🧠 Объясни концепцию</div>
<div class="text-sm text-gray-400">Квантовая физика</div>
</button>
<button onclick="ask('Напиши функцию сортировки массива на Python')" class="p-4 glass rounded-xl text-left hover:bg-white/5 transition">
<div class="font-semibold mb-1">💻 Помощь с кодом</div>
<div class="text-sm text-gray-400">Сортировка на Python</div>
</button>
<button onclick="ask('Создай план обучения английскому языку на месяц')" class="p-4 glass rounded-xl text-left hover:bg-white/5 transition">
<div class="font-semibold mb-1">📚 План обучения</div>
<div class="text-sm text-gray-400">Английский язык</div>
</button>
<button onclick="ask('Придумай 5 креативных идей для стартапа')" class="p-4 glass rounded-xl text-left hover:bg-white/5 transition">
<div class="font-semibold mb-1">💡 Генерация идей</div>
<div class="text-sm text-gray-400">Идеи для бизнеса</div>
</button>
</div>
</div>
</div>
</div>

<div class="glass border-t border-white/10 p-4">
<div class="max-w-4xl mx-auto flex items-center space-x-3">
<textarea id="input" rows="1" placeholder="Введите сообщение..." class="flex-1 glass rounded-2xl p-4 resize-none focus:outline-none bg-transparent focus:ring-2 focus:ring-indigo-500/50 transition" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();send()}" oninput="this.style.height='auto';this.style.height=this.scrollHeight+'px'"></textarea>
<button onclick="send()" class="px-8 py-4 gradient rounded-xl font-semibold hover:opacity-90 transition shadow-lg">
Отправить
</button>
</div>
</div>
</div>

<script>
const API='/api';
let token=localStorage.getItem('token');
let user,chatId;

async function init(){
if(token){
try{
const r=await fetch(API+'/auth/verify',{headers:{'Authorization':'Bearer '+token}});
const d=await r.json();
if(d.success){user=d.user;showApp();return}
}catch(e){console.error(e)}
}
document.getElementById('auth').classList.remove('hidden');
try{
const r=await fetch(API+'/auth/init',{method:'POST'});
const d=await r.json();
document.getElementById('link').href=d.telegramUrl;
document.getElementById('qrimg').src=d.qrCode;
document.getElementById('qr').classList.remove('hidden');
poll(d.authCode);
}catch(e){
alert('Ошибка инициализации: '+e.message);
}
}

async function poll(code){
document.getElementById('btn').classList.add('hidden');
document.getElementById('loading').classList.remove('hidden');
let i=0;
const check=async()=>{
if(i++>=60){alert('Время авторизации истекло. Обновите страницу.');return}
try{
const r=await fetch(API+'/auth/status/'+code);
const d=await r.json();
if(d.success&&d.token){
token=d.token;user=d.user;
localStorage.setItem('token',token);
showApp();
}else if(d.status==='expired'){
alert('Код авторизации истёк. Обновите страницу.');
}else{
setTimeout(check,5000);
}
}catch(e){
setTimeout(check,5000);
}
};
check();
}

function showApp(){
document.getElementById('auth').classList.add('hidden');
document.getElementById('app').classList.remove('hidden');
document.getElementById('userInfo').textContent=(user.username||'User')+' • '+(user.plan||'free').toUpperCase();
loadChat();
}

function logout(){
localStorage.removeItem('token');
location.reload();
}

async function loadChat(){
try{
const r=await fetch(API+'/chat',{headers:{'Authorization':'Bearer '+token}});
const d=await r.json();
if(d.chats&&d.chats.length>0){
chatId=d.chats[0].id;
const r2=await fetch(API+'/chat/'+chatId+'/messages',{headers:{'Authorization':'Bearer '+token}});
const d2=await r2.json();
if(d2.messages&&d2.messages.length>0){
const c=document.getElementById('msgs');
c.innerHTML='<div class="max-w-4xl mx-auto space-y-4 py-4"></div>';
d2.messages.forEach(m=>add(m.role,m.content));
}
}else{
const r2=await fetch(API+'/chat',{
method:'POST',
headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'}
});
const d2=await r2.json();
if(d2.chat)chatId=d2.chat.id;
}
}catch(e){
console.error('Load chat error:',e);
}
}

function add(role,text){
let c=document.getElementById('msgs').querySelector('div');
if(!c||document.getElementById('msgs').querySelector('.text-center')){
document.getElementById('msgs').innerHTML='<div class="max-w-4xl mx-auto space-y-4 py-4"></div>';
c=document.getElementById('msgs').querySelector('div');
}
const div=document.createElement('div');
div.className='flex '+(role==='user'?'justify-end':'justify-start');
if(role==='user'){
div.innerHTML='<div class="max-w-2xl px-6 py-4 gradient rounded-2xl rounded-tr-sm shadow-lg">'+esc(text)+'</div>';
}else{
div.innerHTML='<div class="max-w-2xl px-6 py-4 glass rounded-2xl rounded-tl-sm">'+fmt(text)+'</div>';
}
c.appendChild(div);
setTimeout(()=>c.scrollIntoView({behavior:'smooth',block:'end'}),100);
}

async function send(){
const input=document.getElementById('input');
const text=input.value.trim();
if(!text)return;
add('user',text);
input.value='';
input.style.height='auto';
const typing=addTyping();
try{
const r=await fetch(API+'/chat/'+chatId+'/message',{
method:'POST',
headers:{'Authorization':'Bearer '+token,'Content-Type':'application/json'},
body:JSON.stringify({content:text})
});
const d=await r.json();
typing.remove();
if(d.success){
add('assistant',d.assistantMessage.content);
}else{
alert(d.error||'Ошибка отправки сообщения');
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
div.className='flex';
div.innerHTML='<div class="px-6 py-4 glass rounded-2xl flex items-center space-x-2"><div class="flex space-x-1"><div class="w-2 h-2 bg-indigo-400 rounded-full typing"></div><div class="w-2 h-2 bg-purple-400 rounded-full typing"></div><div class="w-2 h-2 bg-cyan-400 rounded-full typing"></div></div><span class="text-gray-400 text-sm ml-2">AI думает...</span></div>';
c.appendChild(div);
return div;
}

function ask(text){
document.getElementById('input').value=text;
send();
}

function esc(t){
const div=document.createElement('div');
div.textContent=t;
return div.innerHTML;
}

function fmt(t){
return t
.replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
.replace(/\n/g,'<br>')
.replace(/\`(.*?)\`/g,'<code class="bg-slate-800 px-2 py-1 rounded text-sm">$1</code>');
}

init();
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(HTML));
app.get('*', (req, res) => res.send(HTML));

// Start Server
app.listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════╗
║  🤖 AI PLATFORM STARTED                  ║
║  🌐 Port: ${CONFIG.PORT}                            ║
║  📱 Bot: ${CONFIG.TELEGRAM_BOT_USERNAME}             
║  🔗 ${CONFIG.DOMAIN}
║  ✅ Ready to accept connections          ║
╚═══════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Shutting down gracefully...');
  if (bot) bot.stopPolling();
  db.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Shutting down gracefully...');
  if (bot) bot.stopPolling();
  db.close();
  process.exit(0);
});
