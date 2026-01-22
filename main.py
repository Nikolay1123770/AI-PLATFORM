#!/usr/bin/env node
'use strict';

// ============================================================================
// 🤖 AI CHAT PLATFORM - ALL IN ONE FILE
// ============================================================================

require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');

// ============================================================================
// 📊 DATABASE SETUP (SQLite)
// ============================================================================

const db = new Database('database.db');
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL,
    first_name TEXT,
    last_name TEXT,
    role TEXT DEFAULT 'user',
    plan TEXT DEFAULT 'free',
    daily_limit INTEGER DEFAULT 100,
    used_today INTEGER DEFAULT 0,
    total_messages INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    total_chats INTEGER DEFAULT 0,
    last_reset TEXT,
    is_blocked INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_active TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT DEFAULT 'Новый чат',
    model TEXT DEFAULT 'gemini-pro',
    is_favorite INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    model TEXT,
    tokens INTEGER DEFAULT 0,
    processing_time INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (chat_id) REFERENCES chats(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    user_id INTEGER PRIMARY KEY,
    default_model TEXT DEFAULT 'gemini-pro',
    temperature REAL DEFAULT 0.7,
    max_tokens INTEGER DEFAULT 2048,
    language TEXT DEFAULT 'ru',
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Database helpers
const dbHelpers = {
  getUser: db.prepare('SELECT * FROM users WHERE telegram_id = ?'),
  createUser: db.prepare(`
    INSERT INTO users (telegram_id, username, first_name, last_name)
    VALUES (?, ?, ?, ?)
  `),
  updateUser: db.prepare(`
    UPDATE users SET last_active = datetime('now') WHERE id = ?
  `),
  getUserChats: db.prepare(`
    SELECT * FROM chats WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50
  `),
  createChat: db.prepare(`
    INSERT INTO chats (user_id, title, model) VALUES (?, ?, ?)
  `),
  getChat: db.prepare('SELECT * FROM chats WHERE id = ? AND user_id = ?'),
  getChatMessages: db.prepare(`
    SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC
  `),
  createMessage: db.prepare(`
    INSERT INTO messages (chat_id, role, content, model, tokens, processing_time)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  updateChatTimestamp: db.prepare(`
    UPDATE chats SET updated_at = datetime('now') WHERE id = ?
  `),
  incrementUserStats: db.prepare(`
    UPDATE users 
    SET total_messages = total_messages + ?, 
        total_tokens = total_tokens + ?,
        used_today = used_today + 1,
        last_active = datetime('now')
    WHERE id = ?
  `),
  resetDailyLimit: db.prepare(`
    UPDATE users SET used_today = 0, last_reset = date('now') 
    WHERE date(last_reset) < date('now')
  `),
  getAllUsers: db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT 100'),
  getStats: db.prepare(`
    SELECT 
      COUNT(*) as total_users,
      SUM(CASE WHEN date(last_active) = date('now') THEN 1 ELSE 0 END) as active_today
    FROM users
  `)
};

// ============================================================================
// 🤖 AI SERVICE (Multiple Free Models)
// ============================================================================

class AIService {
  constructor() {
    this.models = {
      'gemini-pro': this.geminiChat.bind(this),
      'cohere-command': this.cohereChat.bind(this),
      'huggingface': this.huggingfaceChat.bind(this),
      'together-llama': this.togetherChat.bind(this)
    };
  }

  async generate(model, messages, settings = {}) {
    const startTime = Date.now();
    
    try {
      const handler = this.models[model] || this.models['gemini-pro'];
      const response = await handler(messages, settings);
      
      return {
        content: response.content,
        tokens: response.tokens || this.estimateTokens(response.content),
        processingTime: Date.now() - startTime,
        model
      };
    } catch (error) {
      console.error(`AI Error (${model}):`, error.message);
      
      // Fallback to Gemini if other model fails
      if (model !== 'gemini-pro') {
        return this.generate('gemini-pro', messages, settings);
      }
      
      throw error;
    }
  }

  async geminiChat(messages, settings) {
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_KEY);
    
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-pro',
      generationConfig: {
        temperature: settings.temperature || 0.7,
        maxOutputTokens: settings.max_tokens || 2048,
      }
    });

    const history = messages.slice(0, -1).map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

    const chat = model.startChat({ history });
    const result = await chat.sendMessage(messages[messages.length - 1].content);
    const response = await result.response;

    return {
      content: response.text(),
      tokens: response.usageMetadata?.totalTokenCount || 0
    };
  }

  async cohereChat(messages, settings) {
    const lastMessage = messages[messages.length - 1].content;
    const chatHistory = messages.slice(0, -1).map(msg => ({
      role: msg.role === 'assistant' ? 'CHATBOT' : 'USER',
      message: msg.content
    }));

    const response = await axios.post('https://api.cohere.ai/v1/chat', {
      message: lastMessage,
      chat_history: chatHistory,
      temperature: settings.temperature || 0.7,
      max_tokens: settings.max_tokens || 2048
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.COHERE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    return {
      content: response.data.text,
      tokens: response.data.meta?.tokens?.total_tokens || 0
    };
  }

  async huggingfaceChat(messages, settings) {
    const prompt = this.formatForHF(messages);
    
    const response = await axios.post(
      'https://api-inference.huggingface.co/models/mistralai/Mistral-7B-Instruct-v0.2',
      {
        inputs: prompt,
        parameters: {
          temperature: settings.temperature || 0.7,
          max_new_tokens: settings.max_tokens || 1024,
          return_full_text: false
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.HF_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const content = response.data[0]?.generated_text || 'Ошибка генерации';
    return { content: content.trim() };
  }

  async togetherChat(messages, settings) {
    const response = await axios.post(
      'https://api.together.xyz/v1/chat/completions',
      {
        model: 'meta-llama/Llama-2-7b-chat-hf',
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        temperature: settings.temperature || 0.7,
        max_tokens: settings.max_tokens || 2048
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.TOGETHER_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    return {
      content: response.data.choices[0].message.content,
      tokens: response.data.usage?.total_tokens || 0
    };
  }

  formatForHF(messages) {
    let prompt = '<s>';
    for (const msg of messages) {
      if (msg.role === 'user') {
        prompt += `[INST] ${msg.content} [/INST]`;
      } else {
        prompt += ` ${msg.content}</s>`;
      }
    }
    return prompt;
  }

  estimateTokens(text) {
    return Math.ceil(text.split(/\s+/).length * 1.3);
  }
}

const aiService = new AIService();

// ============================================================================
// 🤖 TELEGRAM BOT
// ============================================================================

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const authRequests = new Map();

console.log('🤖 Telegram Bot started!');

bot.onText(/\/start(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const authCode = match[1].trim();
  
  if (authCode) {
    await handleWebAuth(msg, authCode);
  } else {
    await showMainMenu(msg);
  }
});

async function showMainMenu(msg) {
  const chatId = msg.chat.id;
  const telegramUser = msg.from;
  
  let user = dbHelpers.getUser.get(telegramUser.id.toString());
  
  if (!user) {
    const info = dbHelpers.createUser.run(
      telegramUser.id.toString(),
      telegramUser.username || `user_${telegramUser.id}`,
      telegramUser.first_name || '',
      telegramUser.last_name || ''
    );
    user = dbHelpers.getUser.get(telegramUser.id.toString());
  }

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🚀 Открыть AI Platform', web_app: { url: process.env.DOMAIN } }],
        [
          { text: '👤 Профиль', callback_data: 'profile' },
          { text: '📊 Статистика', callback_data: 'stats' }
        ],
        [{ text: '🤖 Доступные AI', callback_data: 'models' }]
      ]
    }
  };

  await bot.sendMessage(chatId, 
    `🎉 <b>Добро пожаловать в AI Chat Platform!</b>\n\n` +
    `Я - ваш помощник для доступа к мощным AI моделям.\n\n` +
    `🤖 <b>Доступные модели:</b>\n` +
    `🟢 Google Gemini Pro\n` +
    `🔵 Cohere Command\n` +
    `🟣 Hugging Face Mistral\n` +
    `🟡 Together AI Llama 2\n\n` +
    `📱 Откройте веб-платформу для общения с AI!\n\n` +
    `Ваш план: <b>${user.plan.toUpperCase()}</b>\n` +
    `Сообщений сегодня: <b>${user.used_today}/${user.daily_limit}</b>`,
    { parse_mode: 'HTML', ...keyboard }
  );
}

async function handleWebAuth(msg, authCode) {
  const chatId = msg.chat.id;
  const telegramUser = msg.from;

  if (!authRequests.has(authCode)) {
    await bot.sendMessage(chatId, '❌ Неверный или истекший код авторизации');
    return;
  }

  let user = dbHelpers.getUser.get(telegramUser.id.toString());
  
  if (!user) {
    dbHelpers.createUser.run(
      telegramUser.id.toString(),
      telegramUser.username || `user_${telegramUser.id}`,
      telegramUser.first_name || '',
      telegramUser.last_name || ''
    );
    user = dbHelpers.getUser.get(telegramUser.id.toString());
  }

  const token = jwt.sign(
    { userId: user.id, telegramId: user.telegram_id },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  const requestData = authRequests.get(authCode);
  requestData.resolve({ success: true, token, user });
  authRequests.delete(authCode);

  await bot.sendMessage(chatId, 
    `✅ <b>Авторизация успешна!</b>\n\n` +
    `Можете вернуться на сайт и начать работу.\n\n` +
    `План: <b>${user.plan.toUpperCase()}</b>\n` +
    `Лимит: <b>${user.used_today}/${user.daily_limit}</b> сообщений сегодня`,
    { parse_mode: 'HTML' }
  );
}

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const user = dbHelpers.getUser.get(query.from.id.toString());

  if (!user) {
    await bot.answerCallbackQuery(query.id, { text: 'Пользователь не найден' });
    return;
  }

  switch (data) {
    case 'profile':
      await showProfile(chatId, user);
      break;
    case 'stats':
      await showStats(chatId, user);
      break;
    case 'models':
      await showModels(chatId);
      break;
    default:
      await bot.answerCallbackQuery(query.id);
  }
});

async function showProfile(chatId, user) {
  const message = 
    `👤 <b>Ваш профиль</b>\n\n` +
    `ID: <code>${user.telegram_id}</code>\n` +
    `Имя: ${user.first_name} ${user.last_name}\n` +
    `Username: @${user.username}\n` +
    `План: <b>${user.plan.toUpperCase()}</b>\n\n` +
    `📊 <b>Статистика:</b>\n` +
    `Всего сообщений: ${user.total_messages}\n` +
    `Токенов: ${user.total_tokens.toLocaleString('ru-RU')}\n` +
    `Чатов: ${user.total_chats}\n\n` +
    `Регистрация: ${new Date(user.created_at).toLocaleDateString('ru-RU')}`;

  await bot.sendMessage(chatId, message, { 
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back' }]]
    }
  });
}

async function showStats(chatId, user) {
  dbHelpers.resetDailyLimit.run();
  const updatedUser = dbHelpers.getUser.get(user.telegram_id);
  
  const usagePercent = Math.round((updatedUser.used_today / updatedUser.daily_limit) * 100);
  const progressBar = '█'.repeat(Math.floor(usagePercent / 10)) + '░'.repeat(10 - Math.floor(usagePercent / 10));

  const message = 
    `📊 <b>Статистика использования</b>\n\n` +
    `Сегодня:\n${progressBar} ${usagePercent}%\n` +
    `${updatedUser.used_today} / ${updatedUser.daily_limit} сообщений\n\n` +
    `🔥 <b>Всего:</b>\n` +
    `Сообщений: ${updatedUser.total_messages}\n` +
    `Токенов: ${updatedUser.total_tokens.toLocaleString('ru-RU')}\n` +
    `Чатов: ${updatedUser.total_chats}`;

  await bot.sendMessage(chatId, message, { 
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back' }]]
    }
  });
}

async function showModels(chatId) {
  const message = 
    `🤖 <b>Доступные AI модели</b>\n\n` +
    `🟢 <b>Google Gemini Pro</b>\n` +
    `Мощная мультимодальная модель\n` +
    `Лимит: 60 запросов/мин\n\n` +
    `🔵 <b>Cohere Command</b>\n` +
    `Отличная модель для диалогов\n` +
    `Лимит: 100 запросов/мин\n\n` +
    `🟣 <b>Mistral 7B</b>\n` +
    `Open-source модель через HuggingFace\n` +
    `Лимит: без ограничений\n\n` +
    `🟡 <b>Llama 2 7B</b>\n` +
    `Meta Llama через Together AI\n` +
    `Лимит: $25 бесплатных кредитов\n\n` +
    `Все модели абсолютно бесплатны! 🎉`;

  await bot.sendMessage(chatId, message, { 
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'back' }]]
    }
  });
}

// ============================================================================
// 🌐 WEB SERVER (Express)
// ============================================================================

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(require('cors')({ origin: '*' }));

// Auth middleware
const authMiddleware = (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ success: false, message: 'Требуется авторизация' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = dbHelpers.getUser.get(decoded.telegramId);

    if (!user || user.is_blocked) {
      return res.status(401).json({ success: false, message: 'Доступ запрещён' });
    }

    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ success: false, message: 'Неверный токен' });
  }
};

// ============================================================================
// 📡 API ROUTES
// ============================================================================

// Auth - Init
app.post('/api/auth/init', async (req, res) => {
  const authCode = uuidv4();
  const telegramUrl = `https://t.me/${process.env.TELEGRAM_BOT_USERNAME}?start=${authCode}`;

  const authPromise = new Promise((resolve) => {
    authRequests.set(authCode, { resolve, timestamp: Date.now() });
  });

  setTimeout(() => authRequests.delete(authCode), 5 * 60 * 1000);

  res.json({
    success: true,
    authCode,
    telegramUrl,
    qrCode: await QRCode.toDataURL(telegramUrl)
  });

  // Wait for auth (non-blocking)
  authPromise.then(() => {}).catch(() => {});
});

// Auth - Status
app.get('/api/auth/status/:authCode', async (req, res) => {
  const { authCode } = req.params;

  if (!authRequests.has(authCode)) {
    return res.json({ success: false, status: 'expired' });
  }

  try {
    const result = await Promise.race([
      authRequests.get(authCode).resolve,
      new Promise(resolve => setTimeout(() => resolve({ status: 'pending' }), 30000))
    ]);

    res.json(result.success ? result : { success: false, status: 'pending' });
  } catch (error) {
    res.json({ success: false, status: 'error' });
  }
});

// Auth - Verify
app.get('/api/auth/verify', authMiddleware, (req, res) => {
  res.json({ success: true, user: req.user });
});

// Chat - Get all chats
app.get('/api/chat', authMiddleware, (req, res) => {
  const chats = dbHelpers.getUserChats.all(req.user.id);
  res.json({ success: true, chats });
});

// Chat - Create
app.post('/api/chat', authMiddleware, (req, res) => {
  const { title, model } = req.body;
  
  const info = dbHelpers.createChat.run(
    req.user.id,
    title || 'Новый чат',
    model || 'gemini-pro'
  );

  db.prepare('UPDATE users SET total_chats = total_chats + 1 WHERE id = ?').run(req.user.id);

  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(info.lastInsertRowid);
  res.json({ success: true, chat });
});

// Chat - Get messages
app.get('/api/chat/:chatId/messages', authMiddleware, (req, res) => {
  const { chatId } = req.params;
  const chat = dbHelpers.getChat.get(chatId, req.user.id);

  if (!chat) {
    return res.status(404).json({ success: false, message: 'Чат не найден' });
  }

  const messages = dbHelpers.getChatMessages.all(chatId);
  res.json({ success: true, messages });
});

// Chat - Send message
app.post('/api/chat/:chatId/message', authMiddleware, async (req, res) => {
  const { chatId } = req.params;
  const { content } = req.body;

  // Check limits
  dbHelpers.resetDailyLimit.run();
  const user = dbHelpers.getUser.get(req.user.telegram_id);

  if (user.used_today >= user.daily_limit) {
    return res.status(429).json({ 
      success: false, 
      message: 'Достигнут дневной лимит сообщений' 
    });
  }

  const chat = dbHelpers.getChat.get(chatId, user.id);
  if (!chat) {
    return res.status(404).json({ success: false, message: 'Чат не найден' });
  }

  // Save user message
  const userMsgInfo = dbHelpers.createMessage.run(chatId, 'user', content, null, 0, 0);
  const userMessage = db.prepare('SELECT * FROM messages WHERE id = ?').get(userMsgInfo.lastInsertRowid);

  // Get chat history
  const messages = dbHelpers.getChatMessages.all(chatId).map(m => ({
    role: m.role,
    content: m.content
  }));

  try {
    // Get user settings
    let settings = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(user.id);
    if (!settings) {
      db.prepare('INSERT INTO settings (user_id) VALUES (?)').run(user.id);
      settings = { default_model: 'gemini-pro', temperature: 0.7, max_tokens: 2048 };
    }

    // Generate AI response
    const aiResponse = await aiService.generate(chat.model, messages, settings);

    // Save AI message
    const aiMsgInfo = dbHelpers.createMessage.run(
      chatId,
      'assistant',
      aiResponse.content,
      aiResponse.model,
      aiResponse.tokens,
      aiResponse.processingTime
    );

    const assistantMessage = db.prepare('SELECT * FROM messages WHERE id = ?').get(aiMsgInfo.lastInsertRowid);

    // Update chat
    dbHelpers.updateChatTimestamp.run(chatId);

    // Auto-title
    if (messages.length === 1 && chat.title === 'Новый чат') {
      const newTitle = content.substring(0, 50) + (content.length > 50 ? '...' : '');
      db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(newTitle, chatId);
    }

    // Update user stats
    dbHelpers.incrementUserStats.run(2, aiResponse.tokens, user.id);

    res.json({ success: true, userMessage, assistantMessage });

  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Ошибка генерации ответа: ' + error.message 
    });
  }
});

// User - Get profile
app.get('/api/user/profile', authMiddleware, (req, res) => {
  res.json({ success: true, user: req.user });
});

// User - Update settings
app.patch('/api/user/settings', authMiddleware, (req, res) => {
  const { defaultModel, temperature, maxTokens, language } = req.body;
  
  let settings = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(req.user.id);
  
  if (!settings) {
    db.prepare('INSERT INTO settings (user_id) VALUES (?)').run(req.user.id);
    settings = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(req.user.id);
  }

  const updateFields = [];
  const values = [];

  if (defaultModel) {
    updateFields.push('default_model = ?');
    values.push(defaultModel);
  }
  if (temperature !== undefined) {
    updateFields.push('temperature = ?');
    values.push(temperature);
  }
  if (maxTokens) {
    updateFields.push('max_tokens = ?');
    values.push(maxTokens);
  }
  if (language) {
    updateFields.push('language = ?');
    values.push(language);
  }

  if (updateFields.length > 0) {
    values.push(req.user.id);
    db.prepare(`UPDATE settings SET ${updateFields.join(', ')} WHERE user_id = ?`).run(...values);
  }

  settings = db.prepare('SELECT * FROM settings WHERE user_id = ?').get(req.user.id);
  res.json({ success: true, settings });
});

// Admin - Get all users
app.get('/api/admin/users', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Доступ запрещён' });
  }

  const users = dbHelpers.getAllUsers.all();
  res.json({ success: true, users });
});

// Admin - Get stats
app.get('/api/admin/stats', authMiddleware, (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Доступ запрещён' });
  }

  const stats = dbHelpers.getStats.get();
  const totalChats = db.prepare('SELECT COUNT(*) as count FROM chats').get();
  const totalMessages = db.prepare('SELECT COUNT(*) as count FROM messages').get();

  res.json({ 
    success: true, 
    stats: {
      ...stats,
      total_chats: totalChats.count,
      total_messages: totalMessages.count
    }
  });
});

// Models - Get available
app.get('/api/models', (req, res) => {
  res.json({
    success: true,
    models: [
      { id: 'gemini-pro', name: 'Google Gemini Pro', free: true, limits: '60/min' },
      { id: 'cohere-command', name: 'Cohere Command', free: true, limits: '100/min' },
      { id: 'huggingface', name: 'Mistral 7B', free: true, limits: 'Unlimited' },
      { id: 'together-llama', name: 'Llama 2 7B', free: true, limits: '$25 credits' }
    ]
  });
});

// ============================================================================
// 🎨 FRONTEND (HTML в одном файле)
// ============================================================================

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="ru" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Chat Platform - Бесплатный AI Ассистент</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        * { font-family: 'Inter', sans-serif; }
        body { background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); min-height: 100vh; }
        .glass { background: rgba(30, 41, 59, 0.7); backdrop-filter: blur(10px); border: 1px solid rgba(255, 255, 255, 0.1); }
        .gradient-animated { 
            background: linear-gradient(-45deg, #6366f1, #8b5cf6, #06b6d4, #3b82f6);
            background-size: 400% 400%;
            animation: gradient 15s ease infinite;
        }
        @keyframes gradient { 
            0%, 100% { background-position: 0% 50%; }
            50% { background-position: 100% 50%; }
        }
        @keyframes typing {
            0%, 100% { opacity: 0.2; }
            50% { opacity: 1; }
        }
        .typing-dot { animation: typing 1.4s infinite; }
        .typing-dot:nth-child(2) { animation-delay: 0.2s; }
        .typing-dot:nth-child(3) { animation-delay: 0.4s; }
        .message-user { animation: slideInRight 0.3s ease; }
        .message-ai { animation: slideInLeft 0.3s ease; }
        @keyframes slideInLeft {
            from { opacity: 0; transform: translateX(-20px); }
            to { opacity: 1; transform: translateX(0); }
        }
        @keyframes slideInRight {
            from { opacity: 0; transform: translateX(20px); }
            to { opacity: 1; transform: translateX(0); }
        }
        ::-webkit-scrollbar { width: 8px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #4b5563; border-radius: 4px; }
    </style>
</head>
<body class="text-white">

<!-- Auth Modal -->
<div id="authModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm">
    <div class="glass rounded-2xl p-8 max-w-md w-full mx-4">
        <div class="text-center space-y-6">
            <div class="w-20 h-20 gradient-animated rounded-2xl flex items-center justify-center mx-auto">
                <svg class="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
                </svg>
            </div>
            <div>
                <h2 class="text-2xl font-bold mb-2">Авторизация</h2>
                <p class="text-gray-400">Войдите через Telegram для доступа</p>
            </div>
            <div id="authContent" class="space-y-4">
                <div id="authLoading" class="hidden">
                    <div class="flex justify-center space-x-2 mb-4">
                        <div class="w-3 h-3 bg-indigo-500 rounded-full typing-dot"></div>
                        <div class="w-3 h-3 bg-purple-500 rounded-full typing-dot"></div>
                        <div class="w-3 h-3 bg-cyan-500 rounded-full typing-dot"></div>
                    </div>
                    <p class="text-gray-400">Ожидание авторизации...</p>
                </div>
                <div id="authButton">
                    <a id="telegramAuthLink" href="#" target="_blank" class="block w-full py-4 bg-blue-600 hover:bg-blue-500 rounded-xl font-semibold transition flex items-center justify-center space-x-2">
                        <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.894 8.221l-1.97 9.28c-.145.658-.537.818-1.084.508l-3-2.21-1.446 1.394c-.14.18-.357.295-.6.295l.213-3.054 5.56-5.022c.24-.213-.054-.334-.373-.121l-6.869 4.326-2.96-.924c-.64-.203-.658-.64.135-.954l11.566-4.458c.538-.196 1.006.128.832.941z"/></svg>
                        <span>Войти через Telegram</span>
                    </a>
                    <p class="text-xs text-gray-500 mt-3">Нажмите и подтвердите в боте</p>
                </div>
                <div id="qrCode" class="hidden">
                    <img id="qrImage" src="" class="mx-auto bg-white p-4 rounded-xl" />
                    <p class="text-sm text-gray-400 mt-2">Или отсканируйте QR-код</p>
                </div>
            </div>
        </div>
    </div>
</div>

<!-- Main Chat -->
<div id="mainApp" class="hidden h-screen flex flex-col">
    <!-- Header -->
    <div class="glass border-b border-white/10 p-4">
        <div class="max-w-7xl mx-auto flex items-center justify-between">
            <div class="flex items-center space-x-3">
                <div class="w-10 h-10 gradient-animated rounded-lg flex items-center justify-center">
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/>
                    </svg>
                </div>
                <div>
                    <h1 class="font-bold text-lg">AI Platform</h1>
                    <p class="text-xs text-gray-400" id="userInfo">Загрузка...</p>
                </div>
            </div>
            <div class="flex items-center space-x-2">
                <select id="modelSelect" class="px-4 py-2 glass rounded-lg text-sm border border-white/10">
                    <option value="gemini-pro">🟢 Gemini Pro</option>
                    <option value="cohere-command">🔵 Cohere</option>
                    <option value="huggingface">🟣 Mistral</option>
                    <option value="together-llama">🟡 Llama 2</option>
                </select>
                <button onclick="logout()" class="px-4 py-2 glass rounded-lg hover:bg-white/10 transition text-sm">Выйти</button>
            </div>
        </div>
    </div>

    <!-- Messages -->
    <div id="chatMessages" class="flex-1 overflow-y-auto p-4">
        <div class="max-w-4xl mx-auto">
            <div class="text-center py-20">
                <div class="w-20 h-20 gradient-animated rounded-2xl flex items-center justify-center mx-auto mb-6">
                    <svg class="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/>
                    </svg>
                </div>
                <h2 class="text-3xl font-bold mb-4">Задайте любой вопрос</h2>
                <p class="text-gray-400 mb-8">Выберите подсказку или начните вводить</p>
                <div class="grid md:grid-cols-2 gap-4 max-w-2xl mx-auto">
                    <button onclick="sendPrompt('Объясни квантовую физику простыми словами')" class="p-4 glass rounded-xl text-left hover:bg-white/10 transition">
                        <div class="font-semibold mb-1">🧠 Объясни концепцию</div>
                        <div class="text-sm text-gray-400">Квантовая физика для начинающих</div>
                    </button>
                    <button onclick="sendPrompt('Напиши функцию сортировки на Python')" class="p-4 glass rounded-xl text-left hover:bg-white/10 transition">
                        <div class="font-semibold mb-1">💻 Помощь с кодом</div>
                        <div class="text-sm text-gray-400">Функция сортировки массива</div>
                    </button>
                    <button onclick="sendPrompt('Создай план изучения английского на месяц')" class="p-4 glass rounded-xl text-left hover:bg-white/10 transition">
                        <div class="font-semibold mb-1">📚 План обучения</div>
                        <div class="text-sm text-gray-400">Английский с нуля</div>
                    </button>
                    <button onclick="sendPrompt('Придумай 5 идей для стартапа')" class="p-4 glass rounded-xl text-left hover:bg-white/10 transition">
                        <div class="font-semibold mb-1">💡 Генерация идей</div>
                        <div class="text-sm text-gray-400">Инновационные стартапы</div>
                    </button>
                </div>
            </div>
        </div>
    </div>

    <!-- Input -->
    <div class="glass border-t border-white/10 p-4">
        <div class="max-w-4xl mx-auto flex items-center space-x-3">
            <div class="flex-1 glass rounded-2xl p-3">
                <textarea id="messageInput" rows="1" placeholder="Введите сообщение..." class="w-full bg-transparent resize-none focus:outline-none" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMessage();}"></textarea>
            </div>
            <button onclick="sendMessage()" class="px-6 py-3 gradient-animated rounded-xl hover:opacity-90 transition font-semibold">
                Отправить
            </button>
        </div>
    </div>
</div>

<script>
const API = '/api';
let token = localStorage.getItem('token');
let currentUser = null;
let currentChatId = null;

// Auth
async function initAuth() {
    if (token) {
        const valid = await verifyToken();
        if (valid) {
            showApp();
            return;
        }
    }
    
    document.getElementById('authModal').classList.remove('hidden');
    
    const res = await fetch(API + '/auth/init', { method: 'POST' });
    const data = await res.json();
    
    document.getElementById('telegramAuthLink').href = data.telegramUrl;
    document.getElementById('qrImage').src = data.qrCode;
    document.getElementById('qrCode').classList.remove('hidden');
    
    pollAuth(data.authCode);
}

async function pollAuth(code) {
    document.getElementById('authButton').classList.add('hidden');
    document.getElementById('authLoading').classList.remove('hidden');
    
    const maxTries = 60;
    let tries = 0;
    
    const poll = async () => {
        if (tries++ >= maxTries) {
            alert('Время истекло. Обновите страницу.');
            return;
        }
        
        const res = await fetch(API + '/auth/status/' + code);
        const data = await res.json();
        
        if (data.success && data.token) {
            token = data.token;
            currentUser = data.user;
            localStorage.setItem('token', token);
            showApp();
        } else if (data.status === 'expired') {
            alert('Код истёк. Обновите страницу.');
        } else {
            setTimeout(poll, 5000);
        }
    };
    
    poll();
}

async function verifyToken() {
    try {
        const res = await fetch(API + '/auth/verify', {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        const data = await res.json();
        if (data.success) {
            currentUser = data.user;
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

function showApp() {
    document.getElementById('authModal').classList.add('hidden');
    document.getElementById('mainApp').classList.remove('hidden');
    document.getElementById('userInfo').textContent = currentUser.username + ' • ' + currentUser.plan.toUpperCase();
    loadOrCreateChat();
}

function logout() {
    localStorage.removeItem('token');
    location.reload();
}

// Chat
async function loadOrCreateChat() {
    const res = await fetch(API + '/chat', {
        headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    
    if (data.chats.length > 0) {
        currentChatId = data.chats[0].id;
        loadMessages(currentChatId);
    } else {
        const res2 = await fetch(API + '/chat', {
            method: 'POST',
            headers: { 
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ title: 'Новый чат' })
        });
        const data2 = await res2.json();
        currentChatId = data2.chat.id;
    }
}

async function loadMessages(chatId) {
    const res = await fetch(API + '/chat/' + chatId + '/messages', {
        headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    
    const container = document.getElementById('chatMessages');
    container.innerHTML = '<div class="max-w-4xl mx-auto space-y-4"></div>';
    const wrapper = container.querySelector('div');
    
    data.messages.forEach(msg => {
        addMessageToUI(msg.role, msg.content, wrapper);
    });
}

function addMessageToUI(role, content, container = null) {
    if (!container) {
        const chatMessages = document.getElementById('chatMessages');
        if (chatMessages.querySelector('.text-center')) {
            chatMessages.innerHTML = '<div class="max-w-4xl mx-auto space-y-4"></div>';
        }
        container = chatMessages.querySelector('div');
    }
    
    const div = document.createElement('div');
    div.className = 'message-' + role + ' flex ' + (role === 'user' ? 'justify-end' : '');
    
    if (role === 'user') {
        div.innerHTML = '<div class="max-w-2xl px-6 py-4 gradient-animated rounded-2xl rounded-tr-sm">' + escapeHtml(content) + '</div>';
    } else {
        div.innerHTML = '<div class="max-w-2xl px-6 py-4 glass rounded-2xl rounded-tl-sm">' + formatText(content) + '</div>';
    }
    
    container.appendChild(div);
    container.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function addTyping() {
    const container = document.getElementById('chatMessages').querySelector('div');
    const div = document.createElement('div');
    div.id = 'typing';
    div.className = 'message-ai flex';
    div.innerHTML = '<div class="px-6 py-4 glass rounded-2xl rounded-tl-sm flex items-center space-x-2"><div class="flex space-x-1"><div class="w-2 h-2 bg-indigo-400 rounded-full typing-dot"></div><div class="w-2 h-2 bg-purple-400 rounded-full typing-dot"></div><div class="w-2 h-2 bg-cyan-400 rounded-full typing-dot"></div></div><span class="text-gray-400 text-sm ml-2">AI думает...</span></div>';
    container.appendChild(div);
    div.scrollIntoView({ behavior: 'smooth' });
    return div;
}

async function sendMessage() {
    const input = document.getElementById('messageInput');
    const content = input.value.trim();
    if (!content) return;
    
    addMessageToUI('user', content);
    input.value = '';
    
    const typing = addTyping();
    
    try {
        const model = document.getElementById('modelSelect').value;
        
        const res = await fetch(API + '/chat/' + currentChatId + '/message', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + token,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ content })
        });
        
        const data = await res.json();
        typing.remove();
        
        if (data.success) {
            addMessageToUI('assistant', data.assistantMessage.content);
        } else {
            alert(data.message);
        }
    } catch (err) {
        typing.remove();
        alert('Ошибка: ' + err.message);
    }
}

function sendPrompt(text) {
    document.getElementById('messageInput').value = text;
    sendMessage();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatText(text) {
    return text
        .replace(/\\*\\*(.*?)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\\n/g, '<br>')
        .replace(/\`(.*?)\`/g, '<code class="bg-slate-800 px-2 py-1 rounded">$1</code>');
}

initAuth();
</script>

</body>
</html>`;

// Serve HTML
app.get('/', (req, res) => {
  res.send(HTML_TEMPLATE);
});

app.get('*', (req, res) => {
  res.send(HTML_TEMPLATE);
});

// ============================================================================
// 🚀 START SERVER
// ============================================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║     🤖 AI CHAT PLATFORM - STARTED SUCCESSFULLY! 🎉          ║
║                                                              ║
║     📱 Telegram Bot:  ✅ Running                            ║
║     🌐 Web Server:    ✅ Running on port ${PORT}                  ║
║     💾 Database:      ✅ SQLite Connected                   ║
║     🤖 AI Models:     ✅ 4 Free Models Ready                ║
║                                                              ║
║     🔗 URL: ${process.env.DOMAIN || 'http://localhost:' + PORT}
║                                                              ║
║     📚 Available Models:                                     ║
║        🟢 Google Gemini Pro                                 ║
║        🔵 Cohere Command                                    ║
║        🟣 Hugging Face Mistral                              ║
║        🟡 Together AI Llama 2                               ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  bot.stopPolling();
  db.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  bot.stopPolling();
  db.close();
  process.exit(0);
});
