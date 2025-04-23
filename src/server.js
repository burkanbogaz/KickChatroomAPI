const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const axios = require('axios');

// Import custom modules
const KickChatClient = require('./kickChatClient');
const ChatMessageStore = require('./chatMessageStore');

// Pusher configuration from kickChatClient
const PUSHER_CONFIG = {
  key: '32cbd69e4b950bf97679',
  version: '7.6.0',
  clusters: ['us2', 'mt1', 'us3', 'eu', 'ap1', 'ap2', 'ap3', 'ap4']
};

// Configuration
const PORT = process.env.PORT || 3000;

// Initialize the app
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Enable CORS
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Initialize the chat message store
const messageStore = new ChatMessageStore();

// Active chatroom clients
const activeClients = new Map();

// API Routes
app.get('/api/info', (req, res) => {
  res.json({
    status: 'active',
    activeChannels: Array.from(activeClients.keys()),
    messageCount: messageStore.getCount()
  });
});

// Debug endpoint - tüm WebSocket event tiplerini ve detaylarını görüntüle
app.get('/api/debug/:channelName', (req, res) => {
  const { channelName } = req.params;
  
  if (!activeClients.has(channelName)) {
    return res.json({
      error: `Not monitoring channel: ${channelName}`,
      active_channels: Array.from(activeClients.keys())
    });
  }
  
  const client = activeClients.get(channelName);
  const status = client.checkConnectionStatus();
  
  // Ekstra bilgileri içeren detaylı debug bilgisi döndür
  const debugInfo = {
    ...status,
    wsConfig: {
      key: PUSHER_CONFIG.key,
      clusters: PUSHER_CONFIG.clusters,
      version: PUSHER_CONFIG.version
    },
    events: {
      allEvents: Array.from(client.eventTypes),
      count: Array.from(client.eventTypes).length,
      hasMessageEvents: client.hasReceivedChatMessages?.() || false
    },
    stats: {
      raw_message_count: client.messageCounter,
      connection_time: new Date(client.lastKeepAliveTime).toISOString()
    },
    browser_format: client.getBrowserWSPayload?.() || null
  };
  
  res.json(debugInfo);
});

// Test eventi gönderme endpoint'i - manuel test için 
app.post('/api/test-event/:channelName', (req, res) => {
  const { channelName } = req.params;
  const { eventType = 'App\\Events\\ChatMessageEvent', message = 'Test message' } = req.body;
  
  if (!activeClients.has(channelName)) {
    return res.status(404).json({ error: `Not monitoring channel: ${channelName}` });
  }
  
  const client = activeClients.get(channelName);
  
  // Test mesajını yayınla
  const testMessage = {
    id: `test-${Date.now()}`,
    content: message,
    sender: { username: 'TestUser' },
    created_at: new Date().toISOString(),
    type: 'test',
    event_type: eventType
  };
  
  // Mesajı işle
  messageStore.addMessage(channelName, testMessage);
  io.emit('newMessage', { channel: channelName, message: testMessage });
  
  res.json({ 
    success: true, 
    message: `Test event sent to ${channelName}`,
    details: testMessage 
  });
});

// Get all messages for a channel
app.get('/api/messages/:channelName', (req, res) => {
  const { channelName } = req.params;
  const messages = messageStore.getMessagesByChannel(channelName);
  res.json(messages);
});

// Check WebSocket connection status for a channel
app.get('/api/status/:channelName', (req, res) => {
  const { channelName } = req.params;
  
  if (!activeClients.has(channelName)) {
    return res.json({ 
      connected: false,
      status: 'Not monitoring',
      channel: channelName
    });
  }
  
  const client = activeClients.get(channelName);
  const status = client.checkConnectionStatus();
  
  res.json({
    ...status,
    channel: channelName,
    messageCount: messageStore.getMessagesByChannel(channelName).length
  });
});

// Get a sample of recent messages for a channel
app.get('/api/messages/:channelName/recent', (req, res) => {
  const { channelName } = req.params;
  const count = parseInt(req.query.count) || 10;
  
  const allMessages = messageStore.getMessagesByChannel(channelName);
  const recentMessages = allMessages.slice(-count);
  
  res.json({
    channel: channelName,
    count: recentMessages.length,
    totalMessages: allMessages.length,
    messages: recentMessages
  });
});

// Start monitoring a channel
app.post('/api/monitor', async (req, res) => {
  const { channelName } = req.body;
  
  if (!channelName) {
    return res.status(400).json({ error: 'Channel name is required' });
  }
  
  try {
    // Check if already monitoring this channel
    if (activeClients.has(channelName)) {
      return res.json({ 
        success: true, 
        message: `Already monitoring channel: ${channelName}`, 
        isNew: false 
      });
    }
    
    // Create a new client for this channel
    const client = new KickChatClient(channelName);
    
    // Set up message handler
    client.on('message', (message) => {
      console.log(`[SERVER] New message for ${channelName} received, event type: ${message.event_type}`);
      console.log(`[SERVER] Message content: ${JSON.stringify(message.content).substring(0, 100)}...`);
      
      messageStore.addMessage(channelName, message);
      
      // Debug: Emit etmeden önce mesajı kontrol edin
      console.log(`[SERVER] Broadcasting message via Socket.io for ${channelName}`);
      io.emit('newMessage', { 
        channel: channelName, 
        message,
        timestamp: new Date().toISOString() // timestamp ekleyin
      });
    });
    
    client.on('error', (error) => {
      console.error(`Error in channel ${channelName}:`, error);
      io.emit('channelError', { channel: channelName, error: error.message });
    });
    
    // Connect to Kick's chatroom
    await client.connect();
    
    // Store the client
    activeClients.set(channelName, client);
    
    res.json({ 
      success: true, 
      message: `Started monitoring channel: ${channelName}`,
      isNew: true
    });
    
  } catch (error) {
    console.error('Error starting monitoring:', error);
    res.status(500).json({ error: error.message });
  }
});

// Stop monitoring a channel
app.post('/api/unmonitor', (req, res) => {
  const { channelName } = req.body;
  
  if (!channelName) {
    return res.status(400).json({ error: 'Channel name is required' });
  }
  
  if (activeClients.has(channelName)) {
    const client = activeClients.get(channelName);
    client.disconnect();
    activeClients.delete(channelName);
    res.json({ success: true, message: `Stopped monitoring channel: ${channelName}` });
  } else {
    res.status(404).json({ error: `Not monitoring channel: ${channelName}` });
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('New client connected');
  
  socket.on('subscribe', (channelName) => {
    socket.join(channelName);
    console.log(`Client subscribed to ${channelName}`);
  });
  
  socket.on('unsubscribe', (channelName) => {
    socket.leave(channelName);
    console.log(`Client unsubscribed from ${channelName}`);
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Serve the HTML page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Start the server
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
}); 