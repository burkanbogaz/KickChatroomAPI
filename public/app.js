document.addEventListener('DOMContentLoaded', () => {
  const socket = io();
  let currentChannel = '';
  let messageCount = 0;
  
  
  // DOM Elements
  const channelNameInput = document.getElementById('channel-name');
  const startMonitorBtn = document.getElementById('start-monitor');
  const stopMonitorBtn = document.getElementById('stop-monitor');
  const connectionStatus = document.getElementById('connection-status');
  const messageCountDisplay = document.getElementById('message-count');
  const channelSelect = document.getElementById('channel-select');
  const messagesContainer = document.getElementById('messages');
  
  // Initialize by fetching server info
  fetchServerInfo();
  
  // Kanal durumunu periyodik olarak kontrol et
  const statusCheckInterval = setInterval(checkChannelStatus, 10000); // 10 saniyede bir kontrol et
  
  // Event Listeners
  startMonitorBtn.addEventListener('click', startMonitoring);
  stopMonitorBtn.addEventListener('click', stopMonitoring);
  channelSelect.addEventListener('change', changeChannel);
  
  // Real-time event handlers with Socket.io
  socket.on('connect', () => {
    updateStatus('Connected to server');
  });
  
  socket.on('disconnect', () => {
    updateStatus('Disconnected from server');
  });
  
  socket.on('newMessage', (data) => {
    console.log(`[CLIENT] Received newMessage event for channel: ${data.channel}`);
    console.log(`[CLIENT] Current channel: ${currentChannel}`);
    console.log(`[CLIENT] Message: ${JSON.stringify(data.message).substring(0, 200)}...`);
    
    if (data.channel === currentChannel) {
      console.log(`[CLIENT] Appending message to UI`);
      appendMessage(data.message);
      messageCount++;
      updateMessageCount();
    }
  });
  
  socket.on('channelError', (data) => {
    if (data.channel === currentChannel) {
      updateStatus(`Error in channel ${data.channel}: ${data.error}`);
    }
  });
  
  // Functions
  async function startMonitoring() {
    const channelName = channelNameInput.value.trim();
    
    if (!channelName) {
      alert('Please enter a channel name');
      return;
    }
    
    try {
      updateStatus(`Connecting to ${channelName}...`);
      
      const response = await fetch('/api/monitor', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ channelName })
      });
      
      const data = await response.json();
      
      if (data.success) {
        updateStatus(`Connected to ${channelName}`);
        startMonitorBtn.disabled = true;
        stopMonitorBtn.disabled = false;
        
        // Update UI and channel selection
        if (data.isNew) {
          await fetchServerInfo();
        }
        
        // Set as current channel and load messages
        currentChannel = channelName;
        socket.emit('subscribe', channelName);
        await loadChannelMessages(channelName);
        
        // Update the select dropdown
        channelSelect.value = channelName;
      } else {
        updateStatus(`Failed to connect: ${data.message}`);
      }
    } catch (error) {
      console.error('Error starting monitoring:', error);
      updateStatus('Failed to connect. Server error.');
    }
  }
  
  async function stopMonitoring() {
    if (!currentChannel) return;
    
    try {
      const response = await fetch('/api/unmonitor', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ channelName: currentChannel })
      });
      
      const data = await response.json();
      
      if (data.success) {
        updateStatus(`Stopped monitoring ${currentChannel}`);
        socket.emit('unsubscribe', currentChannel);
        
        // Reset UI
        startMonitorBtn.disabled = false;
        stopMonitorBtn.disabled = true;
        currentChannel = '';
        
        // Update channel selection
        await fetchServerInfo();
        clearMessages();
      }
    } catch (error) {
      console.error('Error stopping monitoring:', error);
    }
  }
  
  async function changeChannel() {
    const selectedChannel = channelSelect.value;
    
    if (!selectedChannel) {
      clearMessages();
      currentChannel = '';
      return;
    }
    
    if (selectedChannel !== currentChannel) {
      if (currentChannel) {
        socket.emit('unsubscribe', currentChannel);
      }
      
      currentChannel = selectedChannel;
      socket.emit('subscribe', currentChannel);
      await loadChannelMessages(currentChannel);
      
      // Update the channel name input for consistency
      channelNameInput.value = currentChannel;
      
      // Update buttons
      startMonitorBtn.disabled = true;
      stopMonitorBtn.disabled = false;
      
      updateStatus(`Viewing channel: ${currentChannel}`);
    }
  }
  
  async function fetchServerInfo() {
    try {
      const response = await fetch('/api/info');
      const data = await response.json();
      
      // Update message count
      messageCount = data.messageCount;
      updateMessageCount();
      
      // Update channel select options
      updateChannelSelect(data.activeChannels);
      
    } catch (error) {
      console.error('Error fetching server info:', error);
    }
  }
  
  async function loadChannelMessages(channelName) {
    try {
      clearMessages();
      updateStatus(`Loading messages for ${channelName}...`);
      
      const response = await fetch(`/api/messages/${channelName}`);
      const messages = await response.json();
      
      if (messages.length === 0) {
        appendInfoMessage(`No messages yet for ${channelName}. Wait for new messages.`);
      } else {
        messages.forEach(message => {
          appendMessage(message);
        });
      }
      
      updateStatus(`Viewing channel: ${channelName}`);
    } catch (error) {
      console.error('Error loading messages:', error);
      updateStatus('Failed to load messages');
    }
  }
  
  function updateChannelSelect(channels) {
    // Save current selection
    const currentSelection = channelSelect.value;
    
    // Clear options except the first one
    while (channelSelect.options.length > 1) {
      channelSelect.remove(1);
    }
    
    // Add channel options
    channels.forEach(channel => {
      const option = document.createElement('option');
      option.value = channel;
      option.textContent = channel;
      channelSelect.appendChild(option);
    });
    
    // Restore selection if possible
    if (channels.includes(currentSelection)) {
      channelSelect.value = currentSelection;
    } else if (channels.includes(currentChannel)) {
      channelSelect.value = currentChannel;
    }
  }
  
  function appendMessage(message) {
    const messageEl = document.createElement('div');
    messageEl.className = 'message';
    
    // Message user and timestamp
    const headerEl = document.createElement('div');
    headerEl.className = 'message-header';
    
    const userEl = document.createElement('span');
    userEl.className = 'message-user';
    userEl.textContent = message.sender?.username || 'Anonymous';
    
    const timeEl = document.createElement('span');
    timeEl.className = 'message-time';
    timeEl.textContent = formatTimestamp(message.timestamp || new Date().toISOString());
    
    headerEl.appendChild(userEl);
    headerEl.appendChild(timeEl);
    
    // Message content
    const contentEl = document.createElement('div');
    contentEl.className = 'message-content';
    contentEl.textContent = message.content || message.message || JSON.stringify(message);
    
    // Append to message
    messageEl.appendChild(headerEl);
    messageEl.appendChild(contentEl);
    
    // Add to container and scroll
    messagesContainer.appendChild(messageEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
  
  function appendInfoMessage(text) {
    const messageEl = document.createElement('div');
    messageEl.className = 'message';
    messageEl.style.fontStyle = 'italic';
    messageEl.style.color = '#666';
    messageEl.textContent = text;
    
    messagesContainer.appendChild(messageEl);
  }
  
  function clearMessages() {
    messagesContainer.innerHTML = '';
  }
  
  function updateStatus(status) {
    connectionStatus.textContent = status;
  }
  
  function updateMessageCount() {
    messageCountDisplay.textContent = `${messageCount} messages`;
  }
  
  function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString();
  }
  
  // Aktif kanalın durumunu kontrol et
  async function checkChannelStatus() {
    if (!currentChannel) return;
    
    try {
      const response = await fetch(`/api/status/${currentChannel}`);
      const status = await response.json();
      
      console.log(`[CLIENT] Channel status check: ${JSON.stringify(status)}`);
      
      // Mesaj sayısı ve bağlantı durumunu güncelle
      if (status.messageCount !== undefined) {
        messageCount = status.messageCount;
        updateMessageCount();
      }
      
      // Bağlantı durumu açıklamasını güncelle
      const statusText = `${status.statusText} (${status.readyStateText || 'Unknown'}) - ${status.messageCount || 0} messages, ${status.detectedEvents || 0} events detected`;
      updateStatus(statusText);
      
      // Bağlantı düşerse uyarı ver
      if (!status.connected && currentChannel) {
        appendInfoMessage(`Warning: Connection to ${currentChannel} may be down. Status: ${status.readyStateText || 'Unknown'}`);
      }
    } catch (error) {
      console.error('Error checking channel status:', error);
    }
  }
}); 