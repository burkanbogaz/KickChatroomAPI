# Kick Chatroom API

Bu proje, Kick.com üzerindeki canlı yayın chatroom'larını WebSocket aracılığıyla dinleyen ve gelen mesajları API üzerinden sunan bir Node.js uygulamasıdır. Unity veya başka uygulamalarla entegre edilebilir.

## Özellikler

- Kick.com chatroom'larına WebSocket bağlantısı
- İstediğiniz kanalın sohbet mesajlarını dinleme
- REST API ile mesajlara erişim
- Gerçek zamanlı mesaj bildirimleri için Socket.io desteği
- Aynı anda birden fazla kanalı dinleyebilme
- Kullanıcı dostu test arayüzü

## Başlarken

### Ön Koşullar

- Node.js (v14 veya üstü)
- npm veya yarn

### Kurulum

1. Bu repoyu klonlayın
```
git clone https://github.com/yourusername/kickchatroomapi.git
cd kickchatroomapi
```

2. Gerekli paketleri yükleyin
```
npm install
```

3. Uygulamayı başlatın
```
npm run dev
```

4. Tarayıcınızda `http://localhost:3000` adresine gidin

## API Kullanımı

### REST API Endpoint'leri

#### GET `/api/info`
- Sunucu durumu ve aktif kanallar hakkında bilgi alır

#### GET `/api/messages/:channelName`
- Belirli bir kanal için tüm mesajları alır

#### POST `/api/monitor`
- Yeni bir kanalı dinlemeye başlar
- İstek gövdesi: `{ "channelName": "kanaladi" }`

#### POST `/api/unmonitor`
- Bir kanalı dinlemeyi durdurur
- İstek gövdesi: `{ "channelName": "kanaladi" }`

### Socket.io Olayları

#### `newMessage`
- Yeni bir sohbet mesajı geldiğinde tetiklenir
- Veri formatı: `{ channel: "kanaladi", message: { ... } }`

#### `channelError`
- Bir kanalda hata oluştuğunda tetiklenir
- Veri formatı: `{ channel: "kanaladi", error: "hata mesajı" }`

## Unity Entegrasyonu

Unity projenizde bu API'yi kullanmak için:

1. Unity WebSocket kütüphanesi ekleyin (NuGet üzerinden WebSocketSharp veya başka bir seçenek)
2. Socket.io Client kütüphanesi kullanarak gerçek zamanlı mesajları dinleyin
3. Alternatif olarak, periyodik HTTP istekleri kullanabilirsiniz

```csharp
// Unity C# örnek kod
using UnityEngine;
using UnityEngine.Networking;
using System.Collections;
using System.Collections.Generic;

public class KickChatManager : MonoBehaviour
{
    private string apiUrl = "http://localhost:3000";
    private string channelName = "sizinkanaladi";
    
    void Start()
    {
        StartCoroutine(StartMonitoring());
        InvokeRepeating("FetchMessages", 2.0f, 5.0f);
    }
    
    IEnumerator StartMonitoring()
    {
        WWWForm form = new WWWForm();
        string jsonData = "{\"channelName\":\"" + channelName + "\"}";
        byte[] bodyRaw = System.Text.Encoding.UTF8.GetBytes(jsonData);
        
        UnityWebRequest request = UnityWebRequest.Post(apiUrl + "/api/monitor", "");
        request.uploadHandler = new UploadHandlerRaw(bodyRaw);
        request.downloadHandler = new DownloadHandlerBuffer();
        request.SetRequestHeader("Content-Type", "application/json");
        
        yield return request.SendWebRequest();
        
        if (request.result == UnityWebRequest.Result.Success)
        {
            Debug.Log("Started monitoring channel: " + channelName);
        }
        else
        {
            Debug.LogError("Error: " + request.error);
        }
    }
    
    IEnumerator FetchMessages()
    {
        UnityWebRequest request = UnityWebRequest.Get(apiUrl + "/api/messages/" + channelName);
        yield return request.SendWebRequest();
        
        if (request.result == UnityWebRequest.Result.Success)
        {
            string jsonResult = request.downloadHandler.text;
            // Parse the JSON and process messages
            // ...
        }
    }
}
```

## Lisans

MIT

## İletişim

Sorularınız için [email@example.com](mailto:email@example.com) adresine e-posta gönderebilirsiniz. 