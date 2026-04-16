'use strict';

/**
 * sendMessage/index.js  —  WebSocket `sendMessage` Action Handler
 *
 * The core message routing function. Handles both channel messages and DMs.
 *
 * Route:   sendMessage
 * Payload: {
 *   "action": "sendMessage",
 *   "data": {
 *     "messageID":  "msg_abc123",
 *     "channelId":  "general",          // or "dm_userId1_userId2"
 *     "senderId":   "cognito-sub-uuid",
 *     "senderName": "Alice Smith",
 *     "content":    "Hello team!",
 *     "type":       "message",          // "message" | "announcement"
 *     "priority":   "normal",           // "normal" | "urgent"
 *     "replyTo":    null                // { messageID, senderName, content } or null
 *   }
 * }
 *
 * Flow:
 *  1. Validate the payload (channelId + content are required)
 *  2. Persist the message to MessagesTable (append-only, never deleted)
 *  3. Look up all connectionIds subscribed to the target channelId
 *  4. Fan-out the message to all subscribers via API Gateway Management API
 *  5. Clean up any stale connections (GoneException 410) from both tables
 */

const { v4: uuidv4 } = require('uuid');
const { ApiGatewayManagementApiClient } = require('@aws-sdk/client-apigatewaymanagementapi');

const {
    putMessage,
    getChannelSubscribers,
    deleteConnection,
} = require('/opt/nodejs/db');
const {
    getEndpoint,
    postToConnection,
    sendError,
} = require('/opt/nodejs/ws');

exports.handler = async (event) => {
    const connectionId = event.requestContext.connectionId;
    const endpoint     = getEndpoint(event.requestContext);

    console.log(`[SEND_MSG] from connectionId=${connectionId}`);

    // --- 1. Parse and validate payload ---
    let body;
    try {
        body = JSON.parse(event.body || '{}');
    } catch {
        await sendError(endpoint, connectionId, 'Invalid JSON body');
        return { statusCode: 400, body: 'Bad request' };
    }

    const msgData = body?.data || body;

    if (!msgData?.channelId || !msgData?.content?.trim()) {
        await sendError(endpoint, connectionId, 'Missing required fields: channelId and content');
        return { statusCode: 400, body: 'channelId and content are required' };
    }

    // Sanitise and normalise
    const timestamp = Date.now();
    const message   = {
        messageID:   msgData.messageID  || `msg_${uuidv4()}`,
        channelId:   msgData.channelId,
        senderId:    msgData.senderId   || 'unknown',
        senderName:  msgData.senderName || 'Employee',
        content:     msgData.content.trim(),
        type:        msgData.type       || 'message',
        priority:    msgData.priority   || 'normal',
        timestamp,
        replyTo:     msgData.replyTo    || null,
    };

    // --- 2. Persist to MessagesTable (fire-and-forget style, but await for correctness) ---
    try {
        await putMessage(message);
        console.log(`[SEND_MSG] Persisted messageID=${message.messageID} to ${message.channelId}`);
    } catch (err) {
        console.error(`[SEND_MSG] DynamoDB PutItem error: ${err.message}`);
        await sendError(endpoint, connectionId, 'Failed to store message');
        return { statusCode: 500, body: 'Storage error' };
    }

    // --- 3. Get all subscribers for this channel ---
    let subscribers;
    try {
        subscribers = await getChannelSubscribers(message.channelId);
        console.log(`[SEND_MSG] Found ${subscribers.length} subscribers for ${message.channelId}`);
    } catch (err) {
        console.error(`[SEND_MSG] DynamoDB Query error: ${err.message}`);
        return { statusCode: 500, body: 'Failed to fetch subscribers' };
    }

    if (!subscribers.length) {
        console.log(`[SEND_MSG] No active subscribers for channel ${message.channelId}`);
        return { statusCode: 200, body: 'Message stored, no active subscribers' };
    }

    // --- 4. Fan-out to all subscribers in parallel ---
    const apigw = new ApiGatewayManagementApiClient({ endpoint });
    const outbound = { action: 'sendMessage', data: message };
    const staleConnections = [];

    await Promise.allSettled(
        subscribers.map(async (item) => {
            const targetId = item.connectionId.S;
            const ok = await postToConnection(apigw, targetId, outbound);
            if (!ok) {
                console.warn(`[SEND_MSG] Stale connection detected: ${targetId}`);
                staleConnections.push(targetId);
            }
        })
    );

    console.log(`[SEND_MSG] Delivered to ${subscribers.length - staleConnections.length} connections. Stale: ${staleConnections.length}`);

    // --- 5. Clean up stale connections from ConnectionsTable ---
    // (SubscriptionsTable TTL will handle the rest; explicit delete keeps it snappy)
    if (staleConnections.length > 0) {
        await Promise.allSettled(
            staleConnections.map(staleId =>
                deleteConnection(staleId).catch(err =>
                    console.error(`[SEND_MSG] Failed to delete stale connection ${staleId}: ${err.message}`)
                )
            )
        );
    }

    return { statusCode: 200, body: 'Message delivered' };
};