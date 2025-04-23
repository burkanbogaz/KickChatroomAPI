const WebSocket = require('ws');
const axios = require('axios');
const EventEmitter = require('events');

// Pusher, direkt bağlantı kurmak için gerekli bilgiler
// Kick.com'un gerçek Pusher ayarları! (Kullanıcıdan alınan bilgiye göre güncellendi)
const PUSHER_CONFIG = {
  key: '32cbd69e4b950bf97679', // ÖNEMLİ: Bu yeni key, kullanıcıdan alınan gerçek Kick.com app key'i
  version: '7.6.0',            // Son Pusher versiyonu
  clusters: ['us2', 'mt1', 'us3', 'eu', 'ap1', 'ap2', 'ap3', 'ap4'], // Olası cluster'lar, gerçek cluster en önde
  currentClusterIndex: 0
};

// Kick.com'un mesaj event tiplerini tanımlama
const KICK_EVENT_TYPES = [
  'App\\\\Events\\\\ChatMessageEvent',  // NOT: Çift ters çizgi olmalı (JSON'da escape için)
  'App\\Events\\ChatMessageEvent',
  'App\\Events\\MessageEvent',
  'App\\Events\\ChatMessageSentEvent',
  'App\\Events\\ChatMessageCreatedEvent',
  'App\\Events\\MessageCreatedEvent',
  'App\\Events\\UserBannedEvent',
  'ChatMessageEvent', // Potansiyel basit format
  'MessageEvent',     // Potansiyel basit format
  'ChatMessageCreated', // Potansiyel başka format
  'newMessage',      // Potansiyel başka format
  'App\\Events\\GiftedSubscriptionsEvent',
  'App\\Events\\FollowersUpdateEvent',
  'App\\Events\\SubscriptionEvent',
  'App\\Events\\StreamHostEvent',
  'App\\Events\\ChatModeStatusUpdatedEvent',
  'App\\Events\\PollUpdateEvent',
  'App\\Events\\ChatterBannedEvent',
  'App\\Events\\ChatroomClearEvent',
  'App\\Events\\ChatroomSubscribedEvent',
  'message' // Generic message event
];

// Bir event'in geçerli bir Kick.com event'i olup olmadığını kontrol etme
function isValidKickEvent(eventName) {
  // JavaScript'te string karşılaştırma yaparken backslash escape edildiği için
  // Event tipini normalize edelim: 'App\\Events\\ChatMessageEvent' -> 'App\Events\ChatMessageEvent'
  const normalizedEventName = eventName.replace(/\\\\/g, '\\');
  
  for (const pattern of KICK_EVENT_TYPES) {
    const normalizedPattern = pattern.replace(/\\\\/g, '\\');
    if (normalizedEventName === normalizedPattern) return true;
  }
  
  // Genel olarak App\Events\ ile başlayan herhangi bir event'i kabul edelim
  return normalizedEventName.startsWith('App\\Events\\');
}

class KickChatClient extends EventEmitter {
  constructor(channelName) {
    super();
    this.channelName = channelName;
    this.ws = null;
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 3000; // 3 seconds
    this.receivedFirstMessage = false;
    this.messageCounter = 0;
    this.clusterIndex = 0; // Farklı cluster'ları denemek için
    this.eventTypes = new Set(); // Görülen event tiplerini takip et
    this.debugMode = true; // Ayrıntılı loglama
    this.chatroomId = null; // Gerçek chatroomId'yi saklarız
    this.lastKeepAliveTime = Date.now();
    this.keepAliveInterval = null;
  }

  async connect() {
    try {
      console.log(`Trying to connect to chatroom for ${this.channelName}`);

      // SADECE TARAYICIDAN GÖRÜLEN GERÇEK URL KULLANILACAK
      // Tam olarak tarayıcıdan kopyalandığı şekilde URL kullan
      const chatroomUrl = `wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=7.6.0&flash=false`;
      
      console.log(`Connecting directly to URL: ${chatroomUrl}`);
      
      // En basit bağlantı - hiçbir opsiyon veya header kullanmadan
      this.ws = new WebSocket(chatroomUrl);

      this.ws.on('open', () => {
        this.connected = true;
        console.log(`WebSocket bağlantısı açıldı!`);

        // SADECE BROWSERDA GÖRÜLEN KANAL ADINIZ KULLANIN
        // Bu kanal adı tarayıcıda görünen formatta olmalı (chatrooms.25911944.v2)
        // Örneğin "chatrooms.25911944.v2" gibi
        const channelName = `chatrooms.25911944.v2`; // ÖNEMLI: Bu numarayı kendi chatroom id'nizle değiştirin!
        
        console.log(`Subscribing to exact channel: ${channelName}`);
        
        // Subscribe Payload - tarayıcıdan görülen formatta
        const subscribePayload = JSON.stringify({
          event: 'pusher:subscribe',
          data: {
            auth: '',
            channel: channelName
          }
        });
        
        // Kanal abone isteği gönder
        this.ws.send(subscribePayload);
        console.log(`Subscribe isteği gönderildi: ${subscribePayload}`);
        
        // KeepAlive mekanizması başlat
        this.startKeepAlive();

        this.emit('connected');
      });

      // TÜM MESAJLARI HAM OLARAK LOGLA
      this.ws.on('message', (data) => {
        try {
          const rawData = data.toString();
          
          // Her mesajı ham olarak logla
          console.log(`\n\n=================== RAW WEBSOCKET MESSAGE ===================`);
          console.log(rawData);
          console.log(`============================================================\n\n`);
          
          // Message counter güncelle
          this.messageCounter++;
          this.lastKeepAliveTime = Date.now();
          
          // Mesaj içeriğini JSON olarak parse et
          const parsedData = JSON.parse(rawData);
          
          // ChatMessageEvent ile gelen mesajları yakalamak için özel işlem
          if (parsedData.event === 'App\\Events\\ChatMessageEvent') {
            console.log('✅ CHAT MESSAGE DETECTED!');
            
            try {
              // Event data'sını parse et (string olarak geliyor)
              let messageData;
              try {
                if (typeof parsedData.data === 'string') {
                  // Kick.com'dan gelen veriler bazen eksik olabiliyor, bu yüzden özel kontrol yapıyoruz
                  // Verinin tamamlanmamış olma ihtimaline karşı özel işlem
                  let jsonStr = parsedData.data;
                  
                  // Bozuk JSON kontrolü - çoğu zaman JSON sonunda } karakteri eksik olabiliyor
                  if (!jsonStr.endsWith('}')) {
                    jsonStr = jsonStr + '}';
                  }
                  
                  try {
                    messageData = JSON.parse(jsonStr);
                  } catch (e) {
                    // Belirli kalıplara göre mesaj içeriğini çıkarmayı dene
                    if (jsonStr.includes('"id":"') && jsonStr.includes('"content":"') && jsonStr.includes('"sender":')) {
                      // Manuel parse etmeyi dene
                      const idMatch = jsonStr.match(/"id":"([^"]+)"/);
                      const contentMatch = jsonStr.match(/"content":"([^"]+)"/);
                      const usernameMatch = jsonStr.match(/"username":"([^"]+)"/);
                      
                      messageData = {
                        id: idMatch ? idMatch[1] : `gen-${Date.now()}`,
                        content: contentMatch ? contentMatch[1] : 'Unknown message',
                        sender: {
                          username: usernameMatch ? usernameMatch[1] : 'Unknown user'
                        },
                        created_at: new Date().toISOString()
                      };
                      
                      console.log('🛠️ Manually parsed message data');
                    } else {
                      throw e; // Manuel parse başarısız, hatayı yeniden fırlat
                    }
                  }
                } else {
                  messageData = parsedData.data;
                }
              } catch (e) {
                console.log('JSON parse error:', e);
                
                // Eğer JSON parse edilemiyorsa, string içinde JSON arama
                // Örnek: {"id":"302a768e-a1cd-408d-b924-7940ad904573"...
                const jsonStartIndex = parsedData.data.indexOf('{"id":');
                if (jsonStartIndex >= 0) {
                  try {
                    // JSON'ı sonuna kadar almayı dene
                    let jsonPart = parsedData.data.substring(jsonStartIndex);
                    // Manuel olarak JSON'ı tamamlamaya çalış
                    if (!jsonPart.endsWith('}')) {
                      jsonPart += "}";
                    }
                    messageData = JSON.parse(jsonPart);
                  } catch (e2) {
                    console.log('Failed second JSON parse attempt:', e2);
                    // Bare minimum manuel parse
                    const contentMatch = parsedData.data.match(/content":"([^"]+)"/);
                    const usernameMatch = parsedData.data.match(/username":"([^"]+)"/);
                    
                    messageData = { 
                      content: contentMatch ? contentMatch[1] : parsedData.data,
                      sender: { 
                        username: usernameMatch ? usernameMatch[1] : 'Unknown'
                      }
                    };
                  }
                } else {
                  messageData = { content: parsedData.data };
                }
              }
              
              // Mesaj yapısını kontrol et
              if (messageData) {
                // Chat mesajını oluştur
                const chatMessage = {
                  id: messageData.id || `chat-${Date.now()}`,
                  content: messageData.content || '',
                  sender: messageData.sender || { username: 'Unknown' },
                  created_at: messageData.created_at || new Date().toISOString(),
                  type: messageData.type || 'message',
                  chatroom_id: messageData.chatroom_id || 0,
                  raw_data: messageData
                };
                
                // Mesaj detaylarını göster
                console.log(`👤 From: ${chatMessage.sender.username || 'Unknown'}`);
                console.log(`💬 Message: ${chatMessage.content}`);
                console.log(`⏰ Time: ${chatMessage.created_at}`);
                console.log(`ID: ${chatMessage.id}`);
                
                // Mesajı yayınla
                this.emit('message', chatMessage);
              }
            } catch (error) {
              console.error('Error processing ChatMessageEvent:', error);
            }
          } 
          // Pusher subscription mesajı
          else if (parsedData.event === 'pusher_internal:subscription_succeeded') {
            console.log(`✅ Successfully subscribed to channel!`);
            this.emit('message', {
              id: `system-${Date.now()}`,
              content: `Successfully connected to chatroom. Now listening for messages...`,
              sender: { username: 'System' },
              created_at: new Date().toISOString(),
              type: 'system'
            });
          }
          // Diğer tüm mesajlar için basit log
          else {
            console.log(`📢 Event: ${parsedData.event}`);
            
            // Event tipini kaydet
            if (parsedData.event) {
              this.eventTypes.add(parsedData.event);
            }
          }
        } catch (error) {
          console.error('Error handling WebSocket message:', error);
        }
      });

      this.ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        this.emit('error', error);
      });

      this.ws.on('close', () => {
        this.connected = false;
        console.log(`Connection closed for ${this.channelName}`);
        
        // Keep alive interval'ı temizle
        if (this.keepAliveInterval) {
          clearInterval(this.keepAliveInterval);
          this.keepAliveInterval = null;
        }
        
        // Try to reconnect
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
          
          setTimeout(() => {
            this.connect().catch(error => {
              console.error('Reconnect failed:', error);
            });
          }, this.reconnectDelay);
        } else {
          console.error(`Max reconnect attempts reached for ${this.channelName}`);
          this.emit('maxReconnectAttempts');
        }
      });
      
      return true;
    } catch (error) {
      console.error('Failed to connect to chatroom:', error);
      this.emit('error', error);
      throw error;
    }
  }

  // KeepAlive mekanizması - Pusher bağlantısını canlı tutmak için her 30 saniyede bir ping gönder
  startKeepAlive() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
    }
    
    this.keepAliveInterval = setInterval(() => {
      if (!this.connected || !this.ws) return;
      
      const now = Date.now();
      const timeSinceLastMessage = now - this.lastKeepAliveTime;
      
      // 30 saniyeden fazla mesaj almadıysak ping gönder
      if (timeSinceLastMessage > 30000) {
        console.log('Sending ping to keep connection alive...');
        
        try {
          // Pusher ping event'i
          const pingPayload = JSON.stringify({
            event: 'pusher:ping',
            data: {}
          });
          
          this.ws.send(pingPayload);
        } catch (e) {
          console.error('Error sending ping:', e);
        }
      }
    }, 30000); // 30 saniyede bir kontrol et
  }

  // Kick.com'daki HTML'den chatroom bilgilerini alma
  async scrapeKick(channelName) {
    try {
      console.log('Trying direct HTML scraping approach...');
      
      // User agent'ı gerçek bir Chrome tarayıcısı gibi ayarlayarak bulunmayı zorlaştır
      const response = await axios.get(`https://kick.com/${channelName}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'max-age=0',
          'Sec-Ch-Ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"macOS"',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1'
        }
      });
      
      // HTML içeriğinden gerekli bilgileri çıkaralım
      const html = response.data;
      
      console.log('Successfully fetched HTML from Kick.com');
      
      // Pusher app key'i alalım (eğer değiştiyse)
      const pusherKeyMatch = html.match(/pusher[\s]*:[\s]*{[^}]*key[\s]*:[\s]*['"]([^'"]+)['"]/i);
      if (pusherKeyMatch && pusherKeyMatch[1]) {
        console.log(`Found Pusher key in HTML: ${pusherKeyMatch[1]}`);
        PUSHER_CONFIG.key = pusherKeyMatch[1]; // Global konfigürasyonu güncelle
      }
      
      // Pusher cluster bilgisini alalım
      const pusherClusterMatch = html.match(/pusher[\s]*:[\s]*{[^}]*cluster[\s]*:[\s]*['"]([^'"]+)['"]/i);
      if (pusherClusterMatch && pusherClusterMatch[1]) {
        console.log(`Found Pusher cluster in HTML: ${pusherClusterMatch[1]}`);
        // Bulunan cluster'ı en üste ekleyelim
        if (!PUSHER_CONFIG.clusters.includes(pusherClusterMatch[1])) {
          PUSHER_CONFIG.clusters.unshift(pusherClusterMatch[1]);
        }
        return { cluster: pusherClusterMatch[1] };
      }
      
      // Chatroom ID'yi HTML'den bulmayı deneyelim - farklı formatları kontrol edelim
      const chatRoomPatterns = [
        /"chatroom_id":(\d+)/,
        /"chatroom":[^}]*"id":(\d+)/,
        /data-chatroom-id="(\d+)"/,
        /chatrooms\.(\d+)\.v2/
      ];
      
      for (const pattern of chatRoomPatterns) {
        const match = html.match(pattern);
        if (match && match[1]) {
          const extractedId = match[1];
          console.log(`Found chatroom ID in HTML with pattern ${pattern}: ${extractedId}`);
          return { chatroomId: extractedId };
        }
      }
      
      // Websocket konfigürasyonunu çıkarmayı deneyelim
      const wsConfigMatch = html.match(/window\.ws_config\s*=\s*({[^;]+})/);
      if (wsConfigMatch && wsConfigMatch[1]) {
        try {
          const wsConfig = JSON.parse(wsConfigMatch[1].replace(/'/g, '"'));
          console.log('Found WebSocket config:', wsConfig);
          
          if (wsConfig.key) {
            PUSHER_CONFIG.key = wsConfig.key;
          }
          
          if (wsConfig.cluster) {
            PUSHER_CONFIG.clusters.unshift(wsConfig.cluster);
          }
          
          return wsConfig;
        } catch (e) {
          console.error('Failed to parse WebSocket config:', e);
        }
      }
      
      return null;
    } catch (error) {
      console.error('Error scraping Kick page:', error.message);
      return null;
    }
  }

  // Chatroomid tahmin etme - bazı durumlarda channel name'i kullanmak yeterli olabilir
  // Ancak bu sadece bir tahmindir. Gerçek API çalışmıyorsa bu da çalışmayabilir.
  async getChatroomId(channelName) {
    try {
      // 1. Alternatif: HTML sayfasını parse ederek chatroomId'yi bulmayı deneyelim
      const kickInfo = await this.scrapeKick(channelName);
      if (kickInfo && kickInfo.chatroomId) {
        return kickInfo.chatroomId;
      }
      
      // Eğer HTML scraping'ten cluster bilgisi aldıysak, global değişkeni güncelle
      if (kickInfo && kickInfo.cluster) {
        PUSHER_CONFIG.clusters.unshift(kickInfo.cluster); // Bu cluster'ı en önde dene
        this.clusterIndex = 0; // Index'i sıfırla
      }
      
      // 2. Yöntem: API'den almayı deneyelim
      try {
        console.log('Trying API endpoint...');
        const response = await axios.get(`https://kick.com/api/v2/channels/${channelName}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          }
        });
        
        if (response.data && response.data.chatroom && response.data.chatroom.id) {
          console.log(`Successfully got chatroom ID from API: ${response.data.chatroom.id}`);
          return response.data.chatroom.id;
        }
      } catch (apiError) {
        console.log('Could not get chatroom ID from API');
      }
      
      // 3. Yöntem: İyileştirilmiş tahmin - kanal adı + "chat" deneme
      const guessedId = channelName.toLowerCase(); 
      console.log(`Using channel name as chatroom ID: ${guessedId}`);
      return guessedId;
    } catch (error) {
      console.error('All chatroom ID attempts failed, using channel name:', error);
      return channelName.toLowerCase();
    }
  }

  // WebSocket bağlantısının durumunu kontrol et
  checkConnectionStatus() {
    if (this.ws) {
      return {
        readyState: this.ws.readyState,
        connected: this.connected,
        statusText: this.connected ? 'Connected' : 'Disconnected',
        eventTypes: Array.from(this.eventTypes),
        messageCount: this.messageCounter,
        chatroomId: this.chatroomId,
        lastKeepAliveTime: new Date(this.lastKeepAliveTime).toISOString(),
        // Ek bilgiler
        readyStateText: this.getReadyStateText(),
        detectedEvents: Array.from(this.eventTypes).length,
        hasMessageEvents: this.hasReceivedChatMessages(),
        lastEventTime: this.lastKeepAliveTime ? new Date(this.lastKeepAliveTime).toLocaleTimeString() : 'None'
      };
    }
    return { connected: false, statusText: 'No WebSocket connection' };
  }

  // WebSocket readyState durumunu okunabilir bir metne dönüştür
  getReadyStateText() {
    if (!this.ws) return 'No WebSocket';
    
    const states = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'];
    return states[this.ws.readyState] || 'UNKNOWN';
  }

  // Chat mesajı alınıp alınmadığını kontrol et
  hasReceivedChatMessages() {
    const chatEvents = Array.from(this.eventTypes).filter(
      event => event.includes('Chat') || event.includes('Message')
    );
    return chatEvents.length > 0;
  }

  disconnect() {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
    
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.ws.close();
    }
    this.connected = false;
  }

  isConnected() {
    return this.connected;
  }
  
  // Browser WebSocket format taklidi yapan veri oluştur
  getBrowserWSPayload() {
    return {
      app_key: PUSHER_CONFIG.key,
      version: PUSHER_CONFIG.version,
      channel: `chatrooms.${this.chatroomId}.v2`,
      event: 'App\\Events\\ChatMessageEvent',
      data: JSON.stringify({
        content: 'Test message from Node.js client',
        sender: { username: 'ClientTest' },
        chatroom_id: this.chatroomId,
        created_at: new Date().toISOString()
      })
    };
  }
  
  // Tüm olası event tiplerine abone ol
  subscribeToAllPossibleEvents() {
    if (!this.ws || !this.connected) return false;
    
    console.log('Subscribing to all possible event types...');
    
    // Kick.com event tiplerini kullanarak bind işlemleri yap
    KICK_EVENT_TYPES.forEach(eventType => {
      const bindPayload = JSON.stringify({
        event: 'pusher:subscribe',
        data: {
          auth: '',
          channel: `private-${eventType.replace(/\\/g, '')}`
        }
      });
      
      try {
        this.ws.send(bindPayload);
        console.log(`Bound to event type: ${eventType}`);
      } catch (e) {
        console.error(`Error binding to ${eventType}:`, e);
      }
    });
    
    return true;
  }

  // Event tiplerini bir kanala bağla (bind)
  bindToChannelEvents(channelName) {
    if (!this.ws || !this.connected) return;
    
    console.log(`Binding to events for channel: ${channelName}`);
    
    // Bilinen tüm event tiplerine bind yapma dene
    KICK_EVENT_TYPES.forEach(eventType => {
      const eventName = eventType.replace(/\\/g, '\\\\'); // Escape ters slaşları
      
      // Bind command - Pusher protocol
      const bindPayload = JSON.stringify({
        event: 'pusher:subscribe',
        data: {
          channel: channelName,
          auth: ''
        }
      });
      
      try {
        this.ws.send(bindPayload);
        
        // Direkt event'e de bind et (tarayıcı gibi)
        const directBindPayload = JSON.stringify({
          event: `client-bound-${eventName}`,
          data: {
            channel: channelName
          }
        });
        
        this.ws.send(directBindPayload);
        
        console.log(`Bound to event ${eventType} on channel ${channelName}`);
      } catch (e) {
        console.error(`Error binding to event ${eventType}:`, e);
      }
    });
  }
}

module.exports = KickChatClient; 