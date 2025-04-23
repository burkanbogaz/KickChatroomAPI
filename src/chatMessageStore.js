class ChatMessageStore {
  constructor(options = {}) {
    this.messages = new Map(); // channelName -> messages[]
    this.maxMessagesPerChannel = options.maxMessagesPerChannel || 1000;
  }

  /**
   * Add a new message to the store
   * @param {string} channelName - The channel name
   * @param {object} message - The message object
   */
  addMessage(channelName, message) {
    channelName = channelName ? channelName.toLowerCase() : '';
    
    if (!this.messages.has(channelName)) {
      this.messages.set(channelName, []);
    }

    const channelMessages = this.messages.get(channelName);
    
    // Add timestamp if not present
    if (!message.timestamp) {
      message.timestamp = new Date().toISOString();
    }
    
    // Add the message
    channelMessages.push(message);
    
    // Trim the array if it exceeds the maximum size
    if (channelMessages.length > this.maxMessagesPerChannel) {
      channelMessages.shift(); // Remove the oldest message
    }
  }

  /**
   * Get all messages for a channel
   * @param {string} channelName - The channel name
   * @returns {Array} - Array of messages
   */
  getMessagesByChannel(channelName) {
    channelName = channelName ? channelName.toLowerCase() : '';
    return this.messages.get(channelName) || [];
  }

  /**
   * Get the last N messages for a channel
   * @param {string} channelName - The channel name
   * @param {number} count - Number of messages to return
   * @returns {Array} - Array of messages
   */
  getLastMessages(channelName, count = 10) {
    channelName = channelName ? channelName.toLowerCase() : '';
    const channelMessages = this.messages.get(channelName) || [];
    return channelMessages.slice(-count);
  }

  /**
   * Get the total count of messages across all channels
   * @returns {number} - Total message count
   */
  getCount() {
    let count = 0;
    for (const messages of this.messages.values()) {
      count += messages.length;
    }
    return count;
  }

  /**
   * Get list of active channels
   * @returns {Array} - Array of channel names
   */
  getChannels() {
    return Array.from(this.messages.keys());
  }

  /**
   * Clear messages for a specific channel
   * @param {string} channelName - The channel name
   */
  clearChannel(channelName) {
    channelName = channelName ? channelName.toLowerCase() : '';
    if (this.messages.has(channelName)) {
      this.messages.set(channelName, []);
    }
  }

  /**
   * Clear all messages from all channels
   */
  clearAll() {
    this.messages.clear();
  }
}

module.exports = ChatMessageStore; 