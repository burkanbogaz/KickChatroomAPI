using UnityEngine;
using UnityEngine.Networking;
using System;
using System.Collections;
using System.Text;
using Newtonsoft.Json;
using System.Collections.Generic;
using System.Text.RegularExpressions;

public class SimpleKickChatMonitor : MonoBehaviour
{
    [Header("API Settings")]
    [SerializeField] private string apiBaseUrl = "http://localhost:3000/api";
    [SerializeField] private string channelName = "yourChannelName";
    [SerializeField] private float pollInterval = 2.0f; // How often to check for new messages

    private string lastMessageId = "";
    private bool isMonitoring = false;
    private HashSet<string> processedMessageIds = new HashSet<string>(); // Store processed message IDs

    private void Start()
    {
        // Start monitoring the channel
        StartCoroutine(StartMonitoring());
    }

    private void OnEnable()
    {
        // Start the polling coroutine when enabled
        if (isMonitoring)
        {
            StartCoroutine(PollForNewMessages());
        }
    }

    private void OnDisable()
    {
        // Stop polling when disabled
        StopAllCoroutines();
    }

    private void OnDestroy()
    {
        // Stop monitoring on destroy
        if (isMonitoring)
        {
            // Doğrudan API'yi çağır, coroutine kullanma
            StopMonitoringDirect();
            isMonitoring = false;
        }
    }

    // Start monitoring a channel via HTTP API
    private IEnumerator StartMonitoring()
    {
        string url = $"{apiBaseUrl}/monitor";
        string jsonData = $"{{\"channelName\":\"{channelName}\"}}";

        using (UnityWebRequest request = new UnityWebRequest(url, "POST"))
        {
            byte[] bodyRaw = Encoding.UTF8.GetBytes(jsonData);
            request.uploadHandler = new UploadHandlerRaw(bodyRaw);
            request.downloadHandler = new DownloadHandlerBuffer();
            request.SetRequestHeader("Content-Type", "application/json");

            yield return request.SendWebRequest();

            if (request.result == UnityWebRequest.Result.Success)
            {
                Debug.Log($"Started monitoring channel: {channelName}");
                Debug.Log("Response: " + request.downloadHandler.text);
                isMonitoring = true;
                
                // Start polling for new messages
                StartCoroutine(PollForNewMessages());
                
                // Log a Turkish message for successful connection
                Debug.Log("[Sistem]: Chatroom'a başarıyla bağlanıldı. Mesajlar dinleniyor...");
            }
            else
            {
                Debug.LogError($"Error starting monitoring: {request.error}");
                Debug.LogError("Response: " + request.downloadHandler.text);
            }
        }
    }

    // Poll for new messages periodically
    private IEnumerator PollForNewMessages()
    {
        // İlk başta bekleyelim
        yield return new WaitForSeconds(1.0f);
        
        while (isMonitoring)
        {
            yield return StartCoroutine(GetRecentMessages(10));
            yield return new WaitForSeconds(pollInterval);
        }
    }

    // Stop monitoring a channel
    private IEnumerator StopMonitoring()
    {
        string url = $"{apiBaseUrl}/unmonitor";
        string jsonData = $"{{\"channelName\":\"{channelName}\"}}";

        using (UnityWebRequest request = new UnityWebRequest(url, "POST"))
        {
            byte[] bodyRaw = Encoding.UTF8.GetBytes(jsonData);
            request.uploadHandler = new UploadHandlerRaw(bodyRaw);
            request.downloadHandler = new DownloadHandlerBuffer();
            request.SetRequestHeader("Content-Type", "application/json");

            yield return request.SendWebRequest();

            if (request.result == UnityWebRequest.Result.Success)
            {
                Debug.Log($"Stopped monitoring channel: {channelName}");
                isMonitoring = false;
            }
            else
            {
                Debug.LogError($"Error stopping monitoring: {request.error}");
            }
        }
    }

    // Get recent messages and check for new ones
    private IEnumerator GetRecentMessages(int count = 10)
    {
        string url = $"{apiBaseUrl}/messages/{channelName}/recent?count={count}";

        using (UnityWebRequest request = UnityWebRequest.Get(url))
        {
            yield return request.SendWebRequest();

            if (request.result == UnityWebRequest.Result.Success)
            {
                string jsonResponse = request.downloadHandler.text;
                
                try 
                {
                    // Parse using Newtonsoft.Json
                    MessageResponse response = JsonConvert.DeserializeObject<MessageResponse>(jsonResponse);
                    
                    if (response != null && response.messages != null && response.messages.Length > 0)
                    {
                        // Mesajları tarih sırasına göre sırala (eskiden yeniye)
                        Array.Sort(response.messages, (a, b) => 
                            DateTime.Parse(a.created_at).CompareTo(DateTime.Parse(b.created_at)));
                        
                        foreach (var message in response.messages)
                        {
                            // Eğer bu mesaj ID'sini daha önce işlemediyse göster
                            if (!processedMessageIds.Contains(message.id))
                            {
                                ProcessMessage(message);
                                processedMessageIds.Add(message.id);
                                
                                // Son mesaj ID'sini güncelle
                                if (string.IsNullOrEmpty(lastMessageId) || 
                                    DateTime.Parse(message.created_at) > DateTime.Parse(
                                        response.messages.FirstOrDefault(m => m.id == lastMessageId)?.created_at ?? DateTime.MinValue.ToString()))
                                {
                                    lastMessageId = message.id;
                                }
                            }
                        }
                        
                        // Çok fazla biriken ID olmasın diye eskilerini temizle
                        if (processedMessageIds.Count > 100)
                        {
                            CleanupOldProcessedIds(50); // En son 50 mesajı tut
                        }
                    }
                }
                catch (Exception ex)
                {
                    Debug.LogError($"Error parsing JSON: {ex.Message}");
                }
            }
            else
            {
                Debug.LogError($"Error getting recent messages: {request.error}");
            }
        }
    }
    
    // Eski işlenmiş ID'leri temizle
    private void CleanupOldProcessedIds(int keepCount)
    {
        if (processedMessageIds.Count <= keepCount) return;
        
        // Tüm ID'leri bir listeye kopyala
        List<string> ids = new List<string>(processedMessageIds);
        
        // En son keepCount kadar ID dışındakileri temizle
        int removeCount = ids.Count - keepCount;
        for (int i = 0; i < removeCount; i++)
        {
            processedMessageIds.Remove(ids[i]);
        }
    }

    // Process a message (display in console and/or do something with it)
    private void ProcessMessage(ChatMessage message)
    {
        if (message == null) return;

        // Mesajın zamanını daha okunabilir formata çevirme
        DateTime messageTime;
        string formattedTime = "Unknown time";
        if (!string.IsNullOrEmpty(message.created_at) && DateTime.TryParse(message.created_at, out messageTime))
        {
            formattedTime = messageTime.ToString("HH:mm:ss");
        }

        // Kullanıcı adı ve içeriği al
        string username = message.sender != null ? message.sender.username : "Unknown";
        string content = message.content ?? "No content";
        
        // Mesaj içeriğini temizle (emote veya diğer tekrarlanan içerikleri kaldır)
        content = CleanMessageContent(content);
        
        // Log the message to Unity console in a clean format
        Debug.Log($"[{formattedTime}] [{username}]: {content}");
    }
    
    // Mesaj içeriğinden tekrarlanan emote veya metadata kısımlarını temizle
    private string CleanMessageContent(string content)
    {
        if (string.IsNullOrEmpty(content)) return content;
        
        // [emote:XXXXX:yyyy-zzzzzz] formatındaki içerikleri temizle
        content = Regex.Replace(content, @"\[emote:\d+:[a-zA-Z0-9\-_]+\]", "");
        
        // Çift boşlukları tek boşluğa indir
        content = Regex.Replace(content, @"\s+", " ");
        
        return content.Trim();
    }

    // Simple class structures for JSON parsing
    [Serializable]
    public class MessageResponse
    {
        public string channel;
        public int count;
        public int totalMessages;
        public ChatMessage[] messages;
    }

    [Serializable]
    public class ChatMessage
    {
        public string id;
        public string content;
        public MessageSender sender;
        public string created_at;
        public string type;
        public string event_type;
    }

    [Serializable]
    public class MessageSender
    {
        public string username;
    }

    // Doğrudan API çağrısı yapan metot (coroutine kullanmaz)
    private void StopMonitoringDirect()
    {
        try
        {
            string url = $"{apiBaseUrl}/unmonitor";
            string jsonData = $"{{\"channelName\":\"{channelName}\"}}";
            
            // Basit bir web isteği için WebClient kullanabiliriz
            using (var client = new System.Net.WebClient())
            {
                client.Headers.Add("Content-Type", "application/json");
                client.UploadString(url, "POST", jsonData);
                Debug.Log($"Stopped monitoring channel (direct): {channelName}");
            }
        }
        catch (Exception ex)
        {
            Debug.LogWarning($"Could not cleanly stop monitoring: {ex.Message}");
        }
    }
} 