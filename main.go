package main

import (
	"encoding/json"
	"fmt"
	"html/template"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// ---------------------------------------------------

type Message struct {
	Type           string   `json:"type"` // "message", "user_joined", "user_left", "user_list", "file", "image", "read_receipt", "edit", "delete", "register"
	Sender         string   `json:"sender"`
	Message        string   `json:"message"`
	Users          []string `json:"users,omitempty"` // for user_list type
	FileName       string   `json:"fileName,omitempty"`
	FileData       string   `json:"fileData,omitempty"`       // base64 encoded
	FileType       string   `json:"fileType,omitempty"`       // MIME type
	MessageID      string   `json:"messageId,omitempty"`      // unique message ID
	Status         string   `json:"status,omitempty"`         // "sent", "delivered", "read"
	ReadBy         []string `json:"readBy,omitempty"`         // list of users who read the message
	IsEdited       bool     `json:"isEdited,omitempty"`       // indicates if message was edited
	IsDeleted      bool     `json:"isDeleted,omitempty"`      // indicates if message was deleted
	ProfilePicture string   `json:"profilePicture,omitempty"` // base64 encoded profile picture
}

type Client struct {
	server         *Server
	conn           *websocket.Conn
	send           chan []byte
	username       string
	profilePicture string
}

const (
	writeWait      = 10 * time.Second // time allowed to write a msg to the peer
	maxMessageSize = 10 * 1024 * 1024 // 10MB max message size for files
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  10 * 1024 * 1024, // 10MB for file transfers
	WriteBufferSize: 10 * 1024 * 1024, // 10MB for file transfers
	CheckOrigin:     func(r *http.Request) bool { return true },
}

var homeTempl = template.Must(template.ParseFiles("template/client.html"))

// ---------------------------------------------------

type MessageStatus struct {
	MessageID string
	Sender    string
	ReadBy    map[string]bool // users who have read this message
	mu        sync.RWMutex
}

type UserProfile struct {
	Username       string
	ProfilePicture string
}

type StoredMessage struct {
	Message   Message
	Timestamp time.Time
}

type Server struct {
	clients          map[*Client]bool
	broadcast        chan []byte
	register         chan *Client
	unregister       chan *Client
	usernames        map[string]*Client        // track usernames
	userProfiles     map[string]*UserProfile   // track user profiles
	messageStatus    map[string]*MessageStatus // track message read status
	messages         map[string]*StoredMessage // store all messages for edit/delete
	mu               sync.RWMutex              // protect usernames map
	profileMu        sync.RWMutex              // protect userProfiles map
	msgStatusMu      sync.RWMutex              // protect messageStatus map
	msgStoreMu       sync.RWMutex              // protect messages map
	messageIDCounter int64                     // atomic counter for message IDs
}

func NewServer() *Server {
	return &Server{
		broadcast:        make(chan []byte),
		register:         make(chan *Client),
		unregister:       make(chan *Client),
		clients:          make(map[*Client]bool),
		usernames:        make(map[string]*Client),
		userProfiles:     make(map[string]*UserProfile),
		messageStatus:    make(map[string]*MessageStatus),
		messages:         make(map[string]*StoredMessage),
		messageIDCounter: 0,
	}
}

func (s *Server) getNextMessageID() string {
	id := atomic.AddInt64(&s.messageIDCounter, 1)
	return fmt.Sprintf("msg_%d_%d", time.Now().Unix(), id)
}

func (s *Server) getOnlineUsers() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	users := make([]string, 0, len(s.usernames))
	for username := range s.usernames {
		users = append(users, username)
	}
	return users
}

func (s *Server) broadcastUserList() {
	userList := s.getOnlineUsers()
	msg := Message{
		Type:  "user_list",
		Users: userList,
	}
	jsonMsg, _ := json.Marshal(msg)
	for client := range s.clients {
		select {
		case client.send <- jsonMsg:
		default:
			close(client.send)
			delete(s.clients, client)
		}
	}
}

func (s *Server) broadcastUserJoined(username string) {
	msg := Message{
		Type:    "user_joined",
		Sender:  username,
		Message: username + " joined the chat",
	}
	jsonMsg, _ := json.Marshal(msg)
	for client := range s.clients {
		select {
		case client.send <- jsonMsg:
		default:
			close(client.send)
			delete(s.clients, client)
		}
	}
}

func (s *Server) broadcastUserLeft(username string) {
	msg := Message{
		Type:    "user_left",
		Sender:  username,
		Message: username + " left the chat",
	}
	jsonMsg, _ := json.Marshal(msg)
	for client := range s.clients {
		select {
		case client.send <- jsonMsg:
		default:
			close(client.send)
			delete(s.clients, client)
		}
	}
}

func (s *Server) markMessageAsRead(messageID string, readerUsername string) {
	s.msgStatusMu.Lock()
	defer s.msgStatusMu.Unlock()

	status, exists := s.messageStatus[messageID]
	if !exists {
		return
	}

	status.mu.Lock()
	status.ReadBy[readerUsername] = true
	readByList := make([]string, 0, len(status.ReadBy))
	for user := range status.ReadBy {
		readByList = append(readByList, user)
	}
	status.mu.Unlock()

	// Broadcast read receipt update to sender
	msg := Message{
		Type:      "read_receipt",
		MessageID: messageID,
		Sender:    readerUsername,
		ReadBy:    readByList,
		Status:    "read",
	}
	jsonMsg, _ := json.Marshal(msg)

	// Send to the original sender if they're still connected
	s.mu.RLock()
	if sender, ok := s.usernames[status.Sender]; ok {
		select {
		case sender.send <- jsonMsg:
		default:
		}
	}
	s.mu.RUnlock()
}

func (s *Server) registerMessage(messageID string, sender string) {
	s.msgStatusMu.Lock()
	defer s.msgStatusMu.Unlock()

	s.messageStatus[messageID] = &MessageStatus{
		MessageID: messageID,
		Sender:    sender,
		ReadBy:    make(map[string]bool),
	}
}

func (s *Server) storeMessage(msg Message) {
	s.msgStoreMu.Lock()
	defer s.msgStoreMu.Unlock()

	s.messages[msg.MessageID] = &StoredMessage{
		Message:   msg,
		Timestamp: time.Now(),
	}
}

/*
	func (s *Server) getMessage(messageID string) (*StoredMessage, bool) {
		s.msgStoreMu.RLock()
		defer s.msgStoreMu.RUnlock()

		msg, exists := s.messages[messageID]
		return msg, exists
	}
*/
func (s *Server) getProfilePicture(username string) string {
	s.profileMu.RLock()
	defer s.profileMu.RUnlock()

	if profile, exists := s.userProfiles[username]; exists {
		return profile.ProfilePicture
	}
	return ""
}

func (s *Server) editMessage(messageID string, newContent string, editor string) bool {
	s.msgStoreMu.Lock()
	defer s.msgStoreMu.Unlock()

	storedMsg, exists := s.messages[messageID]
	if !exists {
		return false
	}

	// Check if editor is the original sender
	if storedMsg.Message.Sender != editor {
		return false
	}

	// Update message content
	storedMsg.Message.Message = newContent
	storedMsg.Message.IsEdited = true

	// Broadcast edit to all clients
	editMsg := storedMsg.Message
	editMsg.Type = "edit"
	// Ensure profile picture is included
	if editMsg.ProfilePicture == "" {
		editMsg.ProfilePicture = s.getProfilePicture(editor)
	}
	jsonMsg, err := json.Marshal(editMsg)
	if err != nil {
		fmt.Printf("Error marshaling edit message: %v\n", err)
		return false
	}

	for client := range s.clients {
		select {
		case client.send <- jsonMsg:
		default:
			close(client.send)
			delete(s.clients, client)
		}
	}

	return true
}

func (s *Server) deleteMessage(messageID string, deleter string) bool {
	s.msgStoreMu.Lock()
	defer s.msgStoreMu.Unlock()

	storedMsg, exists := s.messages[messageID]
	if !exists {
		return false
	}

	// Check if deleter is the original sender
	if storedMsg.Message.Sender != deleter {
		return false
	}

	// Mark as deleted
	storedMsg.Message.IsDeleted = true

	// Broadcast delete to all clients
	deleteMsg := Message{
		Type:      "delete",
		MessageID: messageID,
		Sender:    deleter,
		IsDeleted: true,
	}
	jsonMsg, err := json.Marshal(deleteMsg)
	if err != nil {
		fmt.Printf("Error marshaling delete message: %v\n", err)
		return false
	}

	for client := range s.clients {
		select {
		case client.send <- jsonMsg:
		default:
			close(client.send)
			delete(s.clients, client)
		}
	}

	return true
}

func (s *Server) broadcastMessageWithStatus(msg Message) {
	// Mark as delivered for all recipients
	if msg.MessageID != "" {
		s.msgStatusMu.RLock()
		_, exists := s.messageStatus[msg.MessageID]
		s.msgStatusMu.RUnlock()

		if exists {
			// Update status to delivered
			msg.Status = "delivered"
			msg.ReadBy = []string{}
		}
	}

	// Ensure profile picture is included if not present
	if msg.ProfilePicture == "" && msg.Sender != "" {
		msg.ProfilePicture = s.getProfilePicture(msg.Sender)
	}

	jsonMsg, err := json.Marshal(msg)
	if err != nil {
		fmt.Printf("Error marshaling message: %v\n", err)
		return
	}
	for client := range s.clients {
		select {
		case client.send <- jsonMsg:
		default:
			close(client.send)
			delete(s.clients, client)
			if client.username != "" {
				s.mu.Lock()
				delete(s.usernames, client.username)
				s.mu.Unlock()
			}
		}
	}
}

func (s *Server) run() {
	for {
		select {
		case c := <-s.register:
			s.clients[c] = true
			if c.username != "" {
				s.mu.Lock()
				s.usernames[c.username] = c
				s.mu.Unlock()
				fmt.Printf("New client connected: %s\n", c.username)
				s.broadcastUserJoined(c.username)
				s.broadcastUserList()
			} else {
				fmt.Println("New client connected (no username)")
			}
		case c := <-s.unregister:
			if _, ok := s.clients[c]; ok {
				delete(s.clients, c)
				if c.username != "" {
					s.mu.Lock()
					delete(s.usernames, c.username)
					s.mu.Unlock()
					fmt.Printf("Client disconnected: %s\n", c.username)
					s.broadcastUserLeft(c.username)
					s.broadcastUserList()
				} else {
					fmt.Println("Client disconnected")
				}
				close(c.send)
			}
		case message := <-s.broadcast:
			for client := range s.clients {
				select {
				case client.send <- message:
				default:
					close(client.send)
					delete(s.clients, client)
					if client.username != "" {
						s.mu.Lock()
						delete(s.usernames, client.username)
						s.mu.Unlock()
					}
				}
			}
		}
	}
}

// -----------------------CLIENTS----------------------------

func (c *Client) readPump() {
	defer func() {
		c.server.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(maxMessageSize)

	for {
		var msg Message
		if err := c.conn.ReadJSON(&msg); err != nil {
			// ReadJSON will return an error when the connection closes.
			fmt.Println("read error:", err)
			break
		}

		// Handle user registration with profile picture
		if msg.Type == "register" && msg.Sender != "" && msg.ProfilePicture != "" {
			c.username = msg.Sender
			c.profilePicture = msg.ProfilePicture

			// Store user profile
			c.server.profileMu.Lock()
			c.server.userProfiles[c.username] = &UserProfile{
				Username:       c.username,
				ProfilePicture: c.profilePicture,
			}
			c.server.profileMu.Unlock()

			// Add to usernames map and broadcast join event
			c.server.mu.Lock()
			c.server.usernames[c.username] = c
			c.server.mu.Unlock()
			c.server.broadcastUserJoined(c.username)
			c.server.broadcastUserList()
			// Send current user list to the newly connected client
			userList := c.server.getOnlineUsers()
			userListMsg := Message{
				Type:  "user_list",
				Users: userList,
			}
			jsonUserList, _ := json.Marshal(userListMsg)
			select {
			case c.send <- jsonUserList:
			default:
			}
			// Send welcome message to the newly registered user
			welcomeMsg := Message{
				Type:    "user_joined",
				Sender:  c.username,
				Message: c.username + " joined the chat",
			}
			jsonWelcome, _ := json.Marshal(welcomeMsg)
			select {
			case c.send <- jsonWelcome:
			default:
			}
			continue
		}

		// Handle username registration on first message (legacy support)
		if c.username == "" && msg.Sender != "" {
			c.username = msg.Sender
			// Add to usernames map and broadcast join event
			c.server.mu.Lock()
			c.server.usernames[c.username] = c
			c.server.mu.Unlock()
			c.server.broadcastUserJoined(c.username)
			c.server.broadcastUserList()
			// Send current user list to the newly connected client
			userList := c.server.getOnlineUsers()
			userListMsg := Message{
				Type:  "user_list",
				Users: userList,
			}
			jsonUserList, _ := json.Marshal(userListMsg)
			select {
			case c.send <- jsonUserList:
			default:
			}
		}

		// Handle read receipt
		if msg.Type == "read_receipt" && msg.MessageID != "" {
			c.server.markMessageAsRead(msg.MessageID, c.username)
			continue
		}

		// Handle edit message
		if msg.Type == "edit" && msg.MessageID != "" {
			success := c.server.editMessage(msg.MessageID, msg.Message, c.username)
			if !success {
				fmt.Printf("Failed to edit message %s by user %s\n", msg.MessageID, c.username)
			}
			continue
		}

		// Handle delete message
		if msg.Type == "delete" && msg.MessageID != "" {
			success := c.server.deleteMessage(msg.MessageID, c.username)
			if !success {
				fmt.Printf("Failed to delete message %s by user %s\n", msg.MessageID, c.username)
			}
			continue
		}

		// Broadcast chat messages, files, and images
		switch msg.Type {
		case "", "message":
			msg.Type = "message"
			// Assign message ID if not present
			if msg.MessageID == "" {
				msg.MessageID = c.server.getNextMessageID()
				c.server.registerMessage(msg.MessageID, c.username)
				msg.Status = "sent"
			}
			// Add profile picture to message if available
			if msg.ProfilePicture == "" && c.profilePicture != "" {
				msg.ProfilePicture = c.profilePicture
			}
			c.server.storeMessage(msg)
			c.server.broadcastMessageWithStatus(msg)
		case "file", "image":
			// Assign message ID if not present
			if msg.MessageID == "" {
				msg.MessageID = c.server.getNextMessageID()
				c.server.registerMessage(msg.MessageID, c.username)
				msg.Status = "sent"
			}
			// Add profile picture to message if available
			if msg.ProfilePicture == "" && c.profilePicture != "" {
				msg.ProfilePicture = c.profilePicture
			}
			c.server.storeMessage(msg)
			c.server.broadcastMessageWithStatus(msg)
		}
	}
}

func (c *Client) writePump() {
	defer c.conn.Close()

	for message := range c.send {
		// set a write deadline to avoid hanging
		_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))

		// write the message directly
		if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
			fmt.Println("write error:", err)
			break
		}
	}
}

// -----------------------HANDLERS----------------------------

func serveHome(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_ = homeTempl.Execute(w, r.Host)
}

func serveWS(server *Server, w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		fmt.Println("Upgrader:", err)
		return
	}
	client := &Client{
		server:   server,
		conn:     conn,
		send:     make(chan []byte, 256),
		username: "",
	}
	client.server.register <- client

	go client.writePump()
	go client.readPump()
}

// -----------------------MAIN----------------------------

func main() {
	server := NewServer()
	go server.run()

	http.HandleFunc("/", serveHome)
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		serveWS(server, w, r)
	})

	addr := ":8080"
	fmt.Println("Server starting on:", addr)
	if err := http.ListenAndServe(addr, nil); err != nil {
		fmt.Println("ListenAndServe error:", err)
	}
}
