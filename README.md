# 🚀 Real-Time Employee Chat & Announcement Platform (Serverless)

A real-time, serverless messaging platform built on AWS that enables seamless communication within an organization. This system supports direct messaging, department channels, and company-wide announcements — similar to a lightweight Slack.

---

## 📌 Overview

This project demonstrates an event-driven architecture using AWS services to enable low-latency, bidirectional communication without managing servers. It leverages WebSocket APIs for persistent connections and ensures scalable real-time message delivery.

---

## ✨ Features

- 💬 Real-time messaging using WebSocket API  
- 🧑‍🤝‍🧑 Department channels & direct messaging  
- 📢 HR broadcast system (company-wide announcements)  
- 🔄 Auto-reconnect with exponential backoff  
- 🔐 Secure authentication using JWT (Cognito)  
- 📦 Message persistence using DynamoDB  
- 📡 Scalable fan-out using SNS  

---

## 🏗️ Architecture

<img width="1536" height="1024" alt="Real time employee chat and announcement platform" src="https://github.com/user-attachments/assets/5a1b930c-e9cc-4800-ba8b-07bdc616349e" />

---

## 🛠️ Tech Stack

- **Frontend**: HTML, JavaScript (Hosted on Amazon S3)  
- **API Layer**: Amazon API Gateway (WebSocket API)  
- **Compute**: AWS Lambda  
- **Database**: Amazon DynamoDB  
- **Messaging**: Amazon SNS (Broadcast)  
- **Authentication**: Amazon Cognito  

## ⚙️ How It Works

### 1. Connection Lifecycle
- `$connect` Lambda validates JWT token and stores `connectionID` in DynamoDB  
- `$disconnect` Lambda removes connection from DynamoDB  

### 2. Messaging Flow
- Client sends message via WebSocket (`sendMessage` route)  
- Lambda retrieves active connections from DynamoDB  
- Message sent using API Gateway Management API (`post_to_connection`)  

### 3. Broadcast Flow
- HR sends announcement  
- Lambda publishes to SNS  
- SNS triggers another Lambda  
- Message delivered to all active connections  

---

## 📂 Project Structure

├── frontend/
│ ├── employee.html
│ ├── hr.html
│ └── script.js
│
├── backend/
│ ├── connect-handler.py
│ ├── disconnect-handler.py
│ ├── sendMessage.py
│ ├── broadcast.py
│ └── snsToWebSocket.py
│
├── README.md

---

## 🚀 Setup Instructions

### 1. Prerequisites

- AWS Account  
- IAM permissions for Lambda, API Gateway, DynamoDB, SNS, S3  
- Basic knowledge of AWS services  

---

### 2. Create DynamoDB Tables

#### Connections Table
- Partition Key: `connectionID`  
- Attributes: employee_id, channel  
- TTL enabled (optional)

#### Messages Table
- Partition Key: `message_id`  
- Sort Key: `channel_id`  

---

### 3. Setup Cognito

- Create User Pool  
- Configure App Client (disable client secret)  
- Use Hosted UI for login  
- Retrieve JWT (`id_token`) after login  

---

### 4. Deploy Lambda Functions

Create the following Lambda functions:

- `connect-handler`  
- `disconnect-handler`  
- `sendMessage`  
- `broadcast`  
- `snsToWebSocket`  

Set environment variables:

WS_ENDPOINT = https://<api-id>.execute-api.<region>.amazonaws.com/dev

---

### 5. Create WebSocket API

- Use API Gateway → WebSocket API  
- Add routes:
  - `$connect`
  - `$disconnect`
  - `sendMessage`
  - `broadcast`
- Attach respective Lambda integrations  
- Deploy to `dev` stage  

---

### 6. Setup SNS

- Create topic for announcements  
- Subscribe Lambda (`snsToWebSocket`)  

---

### 7. Deploy Frontend

- Upload frontend files to S3  
- Enable static website hosting  

Use WebSocket URL: 

wss://4ixt0u88xg.execute-api.ap-south-1.amazonaws.com/dev

---

## 🧪 Testing

- Open app in multiple browser tabs  
- Send messages between users  
- Verify real-time delivery  
- Trigger HR broadcast and check all clients  

---

## ⚡ Challenges & Learnings

- Managed WebSocket connection lifecycle  
- Debugged Lambda timeout and endpoint issues  
- Fixed DynamoDB key mismatches (case-sensitive keys)  
- Handled stale connections (GoneException)  
- Implemented real-time UI updates  

---

## 📸 Screenshots (Add Here)

- Real-time chat between users  
- HR broadcast feature  
- Architecture diagram  
- DynamoDB tables  
- API Gateway Invoke URL 

---

## 📈 Future Improvements

- Add user presence (online/offline status)  
- Implement message read receipts  
- Add file sharing support  
- Improve UI/UX (Slack-like interface)  

---

## 👨‍💻 Author

S Manjunath  
AWS Cloud Intern  

---

## 📜 License

This project is for educational purposes.


