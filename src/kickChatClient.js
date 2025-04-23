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
  constructor(channelNameOrId) {
    super();
    
    // Eğer sayı veya ID formunda bir değer girildiyse, doğrudan chatroom ID olarak kullan
    if (/^\d+$/.test(channelNameOrId)) {
      // Sayısal bir ID girilmiş, doğrudan chatroom ID olarak kabul et
      this.chatroomId = channelNameOrId;
      this.channelName = `ID-${channelNameOrId}`; // Gösterim amaçlı 
      console.log(`📌 Doğrudan Chatroom ID kullanılıyor: ${this.chatroomId}`);
    } else {
      // Normal kanal adı girilmiş
      this.channelName = channelNameOrId;
      this.chatroomId = null; // API'den alınacak
    }
    
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
    this.lastKeepAliveTime = Date.now();
    this.keepAliveInterval = null;
  }

  async connect() {
    try {
      console.log(`\n==================================================`);
      console.log(`📢 KANAL BAĞLANTI BAŞLATILIYOR: "${this.channelName}"`);
      console.log(`==================================================\n`);

      // İlk olarak chatroom ID'yi tespit et (eğer constructor'da belirtilmediyse)
      if (!this.chatroomId) {
        try {
          this.chatroomId = await this.getChatroomId(this.channelName);
          console.log(`\n🎯 CHATROOM ID TESPİT EDİLDİ: ${this.chatroomId}`);
          console.log(`📌 KANAL ADI: ${this.channelName}`);
          console.log(`📌 HEDEF CHATROOM ID: ${this.chatroomId}`);
          console.log(`📌 HEDEF KANAL: chatrooms.${this.chatroomId}.v2\n`);
        } catch (idError) {
          console.error(`\n❌ CHATROOM ID TESPİT HATASI!`);
          console.error(`❌ HATA: ${idError.message}\n`);
          
          // CloudFlare engeline takıldığında manuel ID desteği
          if (idError.message.includes('403')) {
            console.log(`\n⚠️ API'ye erişim engellendi. Manuel ID denemesi yapılabilir.`);
            
            // İyi bilinen bazı kanal ID'leri
            const knownChannelIds = {
              'xqc': '25911944',  // xQc kanalı
              'asmongold': '25578458', // Asmongold kanalı
              'bukidev': '27670567', // BukiDev kanalı
              'b0aty': '26770211'  // b0aty kanalı
            };
            
            // Kanal adı bilinen bir kanal mı kontrol et
            if (knownChannelIds[this.channelName.toLowerCase()]) {
              this.chatroomId = knownChannelIds[this.channelName.toLowerCase()];
              console.log(`\n✅ BİLİNEN KANAL LİSTESİNDEN ID BULUNDU: ${this.chatroomId}`);
              console.log(`📌 KANAL ADI: ${this.channelName}`);
              console.log(`📌 HEDEF CHATROOM ID: ${this.chatroomId}`);
              console.log(`📌 HEDEF KANAL: chatrooms.${this.chatroomId}.v2\n`);
            } else {
              throw new Error(`Kanal ID'si alınamadı ve bilinen kanallar listesinde bulunamadı: ${this.channelName}`);
            }
          } else {
            throw idError;
          }
        }
      } else {
        // Zaten bir chatroom ID mevcut (constructor'da belirtilmiş)
        console.log(`\n✅ CHATROOM ID ZATEN BELİRTİLMİŞ: ${this.chatroomId}`);
        console.log(`📌 KANAL ADI: ${this.channelName}`);
        console.log(`📌 HEDEF KANAL: chatrooms.${this.chatroomId}.v2\n`);
      }

      if (!this.chatroomId) {
        throw new Error(`Could not detect chatroom ID for ${this.channelName}. Connection attempt aborted.`);
      }

      // SADECE TARAYICIDAN GÖRÜLEN GERÇEK URL KULLANILACAK
      // Tam olarak tarayıcıdan kopyalandığı şekilde URL kullan
      const chatroomUrl = `wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=7.6.0&flash=false`;
      
      console.log(`Connecting directly to URL: ${chatroomUrl}`);
      
      // En basit bağlantı - hiçbir opsiyon veya header kullanmadan
      this.ws = new WebSocket(chatroomUrl);

      this.ws.on('open', () => {
        this.connected = true;
        console.log(`\n✅ WEBSOCKET BAĞLANTISI KURULDU!`);

        // Dinamik olarak oluşturulan chatroom kanalını kullan
        const channelName = `chatrooms.${this.chatroomId}.v2`;
        
        console.log(`\n📣 ABONE OLUNUYOR: "${channelName}"`);
        console.log(`📡 Chatroom: ${this.channelName} (ID: ${this.chatroomId})`);
        
        // Subscribe Payload - tarayıcıdan görülen formatta
        const subscribePayload = JSON.stringify({
          event: 'pusher:subscribe',
          data: {
            auth: '',
            channel: channelName
          }
        });
        
        // Kanal abone isteği gönder
        try {
          this.ws.send(subscribePayload);
          console.log(`✅ ABONE OLMA İSTEĞİ GÖNDERİLDİ`);
          console.log(`📦 Gönderilen veri: ${subscribePayload}`);
        } catch (sendError) {
          console.error(`❌ ABONE OLMA İSTEĞİ GÖNDERİLİRKEN HATA OLUŞTU:`, sendError);
        }
        
        // KeepAlive mekanizması başlat
        this.startKeepAlive();

        this.emit('connected');
      });

      // TÜM MESAJLARI HAM OLARAK LOGLA
      this.ws.on('message', (data) => {
        try {
          const rawData = data.toString();
          
          // Her mesajı ham olarak logla
          console.log(`\n\n=================== WEBSOCKET MESAJI ALINDI ===================`);
          console.log(rawData);
          console.log(`============================================================\n\n`);
          
          // Message counter güncelle
          this.messageCounter++;
          this.lastKeepAliveTime = Date.now();
          
          // Mesaj içeriğini JSON olarak parse et
          const parsedData = JSON.parse(rawData);
          
          // ChatMessageEvent ile gelen mesajları yakalamak için özel işlem
          if (parsedData.event === 'App\\Events\\ChatMessageEvent') {
            console.log('✅ CHAT MESAJI ALINDI!');
            
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
                console.log(`\n------ CHAT MESAJI DETAYLARI ------`);
                console.log(`👤 GÖNDEREN: ${chatMessage.sender.username || 'Bilinmiyor'}`);
                console.log(`💬 MESAJ: ${chatMessage.content}`);
                console.log(`⏰ ZAMAN: ${chatMessage.created_at}`);
                console.log(`🆔 MESAJ ID: ${chatMessage.id}`);
                console.log(`----------------------------------\n`);
                
                // Mesajı yayınla
                this.emit('message', chatMessage);
              }
            } catch (error) {
              console.error('❌ Chat mesajı işlenirken hata oluştu:', error);
            }
          } 
          // Pusher subscription mesajı
          else if (parsedData.event === 'pusher_internal:subscription_succeeded') {
            console.log(`\n✅ KANALA BAŞARIYLA ABONE OLUNDU! (${parsedData.channel || 'kanal bilgisi yok'})`);
            this.emit('message', {
              id: `system-${Date.now()}`,
              content: `Chatroom'a başarıyla bağlanıldı. Mesajlar dinleniyor...`,
              sender: { username: 'Sistem' },
              created_at: new Date().toISOString(),
              type: 'system'
            });
          }
          // Diğer tüm mesajlar için basit log
          else {
            console.log(`📢 OLAY: ${parsedData.event || 'Olay adı yok'}`);
            console.log(`📦 VERİ: ${JSON.stringify(parsedData.data || {}).substring(0, 300)}...`);
            
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

  // Kanal adından chatroom ID'yi almak için API kullanan fonksiyon
  async getChatroomId(channelName) {
    try {
      console.log(`\n📡 "${channelName}" için Kick.com API sorgusu yapılıyor...`);
      
      // API'den kanal bilgilerini al (tarayıcı gibi davranarak)
      const response = await axios.get(`https://kick.com/api/v2/channels/${channelName}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9,tr;q=0.8',
          'Cache-Control': 'no-cache',
          'DNT': '1',
          'Origin': 'https://kick.com',
          'Referer': `https://kick.com/${channelName}`,
          'Sec-Ch-Ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"macOS"',
          'Sec-Fetch-Dest': 'empty',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin'
        },
        withCredentials: true,
        timeout: 10000
      });
      
      // API yanıtını kontrol et
      console.log(`\n✅ API yanıtı alındı (HTTP ${response.status})`);
      
      // Chatroom ID'yi çıkar
      if (response.data && response.data.chatroom && response.data.chatroom.id) {
        const chatroomId = response.data.chatroom.id;
        
        // Chatroom detaylarını yazdır
        console.log(`\n=== CHATROOM BİLGİLERİ (API'den) ===`);
        console.log(`🆔 Chatroom ID: ${chatroomId}`);
        console.log(`📝 Chatroom Adı: ${response.data.chatroom.name || 'Belirtilmemiş'}`);
        console.log(`👥 Kullanıcı Sayısı: ${response.data.chatroom.follower_count || 'Belirtilmemiş'}`);
        console.log(`🔗 Slug: ${response.data.slug || 'Belirtilmemiş'}`);
        
        // Kanal hakkında ek bilgiler
        if (response.data.user) {
          console.log(`👤 Kanal Sahibi: ${response.data.user.username || 'Belirtilmemiş'}`);
        }
        
        console.log(`\n✅ CHATROOM ID BAŞARILI BİR ŞEKİLDE ALINDI: ${chatroomId}`);
        return chatroomId;
      }
      
      // Alternatif Yöntem: Özel API bağlantısı
      console.log(`\n⚠️ API yanıtında chatroom ID bulunamadı, alternatif yöntem deneniyor...`);
      
      try {
        // Web API endpoint'ini farklı formatta deneyerek
        const altResponse = await axios.get(`https://kick.com/${channelName}/chatroom`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Referer': `https://kick.com/${channelName}`,
            'Origin': 'https://kick.com'
          }
        });
        
        if (altResponse.data && altResponse.data.id) {
          const chatroomId = altResponse.data.id;
          console.log(`✅ Alternatif API'den Chatroom ID alındı: ${chatroomId}`);
          return chatroomId;
        }
      } catch (altError) {
        console.log(`Alternatif API çağrısı başarısız: ${altError.message}`);
      }
      
      // Doğrudan HTML sayfasını indirip içinden ID'yi çıkarmayı dene
      console.log(`\n🔍 Doğrudan HTML sayfasından chatroom ID çıkarılmaya çalışılıyor...`);
      
      try {
        const htmlResponse = await axios.get(`https://kick.com/${channelName}`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Accept': 'text/html',
            'Accept-Language': 'en-US,en;q=0.9',
          }
        });
        
        const html = htmlResponse.data;
        
        // HTML içinde chatroom ID'yi ara
        const chatroomMatch = html.match(/chatrooms\.(\d+)\.v2/);
        if (chatroomMatch && chatroomMatch[1]) {
          const chatroomId = chatroomMatch[1];
          console.log(`✅ HTML sayfasından Chatroom ID çıkarıldı: ${chatroomId}`);
          return chatroomId;
        }
      } catch (htmlError) {
        console.log(`HTML sayfası indirilemedi: ${htmlError.message}`);
      }
      
      // Debug için tüm yanıtı göster
      console.log(`\n⚠️ Hiçbir yöntem chatroom ID'yi bulamadı.`);
      
      // CloudFlare korumasını aşamadık, fallback olarak statik ID kullan
      console.log(`\n⚠️ API istekleri CloudFlare koruması tarafından engelleniyor olabilir`);
      console.log(`⚠️ Manuel müdahale gerekebilir. Bilinen bir kanal ID'si kullanılabilir`);
      
      // Eğer chatroom ID bulunamazsa hata fırlat
      throw new Error(`API yanıtında chatroom.id bulunamadı. Kanal adı: "${channelName}"`);
    } catch (error) {
      console.error(`\n❌ HATA: "${channelName}" için chatroom ID alınamadı!`);
      
      // Hata durumunda daha detaylı bilgi
      if (error.response) {
        console.log(`⚠️ HTTP Durumu: ${error.response.status}`);
        if (error.response.status === 403) {
          console.log(`⚠️ CloudFlare koruması engelliyor olabilir. Tarayıcınızdan API'yi kontrol edin ve ID'yi manuel olarak girin.`);
          console.log(`⚠️ Connect metodunda doğrudan ID kullanmak için kodu düzenleyin.`);
        } else {
          console.log(`⚠️ Hata detayı:`, error.response.data);
        }
      } else {
        console.log(`⚠️ Hata mesajı: ${error.message}`);
      }
      
      throw new Error(`"${channelName}" için chatroom ID alınamadı: ${error.message}`);
    }
  }

  // WebSocket bağlantısının durumunu kontrol et
  checkConnectionStatus() {
    if (this.ws) {
      const statusInfo = {
        readyState: this.ws.readyState,
        connected: this.connected,
        statusText: this.connected ? 'Bağlı' : 'Bağlantı Kesildi',
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
      
      // Durum bilgilerini konsola yazdır
      console.log(`\n==== BAĞLANTI DURUMU ====`);
      console.log(`📡 Kanal: ${this.channelName}`);
      console.log(`🆔 Chatroom ID: ${this.chatroomId}`);
      console.log(`🔌 Durum: ${statusInfo.statusText} (${statusInfo.readyStateText})`);
      console.log(`📊 Alınan Mesaj Sayısı: ${statusInfo.messageCount}`);
      console.log(`📋 Tespit Edilen Olay Tipleri: ${statusInfo.detectedEvents}`);
      console.log(`⏱️ Son Olay Zamanı: ${statusInfo.lastEventTime}`);
      console.log(`📨 Chat Mesajları Alındı: ${statusInfo.hasMessageEvents ? 'Evet' : 'Hayır'}`);
      console.log(`=======================\n`);
      
      return statusInfo;
    }
    return { connected: false, statusText: 'WebSocket bağlantısı yok' };
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