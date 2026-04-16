'use strict';

/**
 * broadcast/index.js  —  SNS-Triggered HR Announcement Broadcaster
 *
 * Triggered by the S2MB_Announcements SNS topic whenever HR publishes
 * a company-wide announcement from the HR Admin dashboard.
 *
 * Trigger: SNS → Lambda (configured in template.yaml)
 *
 * SNS Message JSON format (from HR Admin frontend):
 * {
 *   "messageID":  "msg_hr_abc123",
 *   "channelId":  "general",
 *   "senderId":   "hr_admin",
 *   "senderName": "HR Admin",
 *   "content":    "Offices will be closed on Monday.",
 *   "type":       "announcement",
 *   "priority":   "normal",            // "normal" | "urgent"
 *   "timestamp":  1712345678900
 * }
 *
 * Flow:
 *  1. Parse the SNS message (SNS wraps the payload in a Records array)
 *  2. Persist the announcement to MessagesTable
 *  3. Scan ALL active connections from ConnectionsTable
 *  4. Push the announcement to every connected employee simultaneously
 *  5. Clean up stale connections (GoneException)
 *
 * Why scan all connections?
 *  Announcements are company-wide — every connected employee should receive
 *  them regardless of which channel they're currently viewing. The client
 *  injects the announcement into the active chat view.
 */

const { v4: uuidv4 } = require('uuid');

const {
    putMessage,
    getAllConnections,
    deleteConnection,
} = require('/opt/nodejs/db');
const { broadcastToConnections } = require('/opt/nodejs/ws');

// The APIGW Management endpoint for this stage
// Stored as an environment variable set in template.yaml by Outputs
const APIGW_ENDPOINT = process.env.WEBSOCKET_API_ENDPOINT;

exports.handler = async (event) => {
    console.log(`[BROADCAST] Received ${event.Records.length} SNS record(s)`);

    for (const record of event.Records) {
        if (record.EventSource !== 'aws:sns') {
            console.warn('[BROADCAST] Skipping non-SNS record:', record.EventSource);
            continue;
        }

        // --- 1. Parse the SNS message body ---
        let announcement;
        try {
            announcement = JSON.parse(record.Sns.Message);
        } catch (err) {
            console.error('[BROADCAST] Failed to parse SNS message:', record.Sns.Message);
            continue;
        }

        // Set fallback defaults
        const message = {
            messageID:   announcement.messageID  || `msg_hr_${uuidv4()}`,
            channelId:   announcement.channelId  || 'general',
            senderId:    announcement.senderId   || 'hr_admin',
            senderName:  announcement.senderName || 'HR Admin',
            content:     announcement.content    || '',
            type:        'announcement',
            priority:    announcement.priority   || 'normal',
            timestamp:   announcement.timestamp  || Date.now(),
            replyTo:     null,
        };

        if (!message.content) {
            console.warn('[BROADCAST] Skipping empty announcement');
            continue;
        }

        console.log(`[BROADCAST] Processing announcement: priority=${message.priority} channelId=${message.channelId}`);

        // --- 2. Persist to MessagesTable ---
        try {
            await putMessage(message);
            console.log(`[BROADCAST] Persisted announcement ${message.messageID}`);
        } catch (err) {
            console.error(`[BROADCAST] Failed to persist announcement: ${err.message}`);
            // Continue to push anyway — don't block delivery
        }

        // --- 3. Fetch all active connections ---
        let connections;
        try {
            connections = await getAllConnections();
            console.log(`[BROADCAST] Found ${connections.length} active connection(s)`);
        } catch (err) {
            console.error(`[BROADCAST] Failed to scan connections: ${err.message}`);
            continue;
        }

        if (!connections.length) {
            console.log('[BROADCAST] No active connections — announcement stored only');
            continue;
        }

        // --- 4. Fan-out to all active connections ---
        const connectionIds = connections.map(c => c.connectionId.S);
        const outbound      = { action: 'sendMessage', data: message };

        let staleIds;
        try {
            staleIds = await broadcastToConnections(APIGW_ENDPOINT, connectionIds, outbound);
            console.log(`[BROADCAST] Delivered to ${connectionIds.length - staleIds.length} connections. Stale: ${staleIds.length}`);
        } catch (err) {
            console.error(`[BROADCAST] Fan-out error: ${err.message}`);
            continue;
        }

        // --- 5. Clean up stale connections ---
        if (staleIds.length > 0) {
            console.log(`[BROADCAST] Cleaning up ${staleIds.length} stale connection(s)`);
            await Promise.allSettled(
                staleIds.map(sid =>
                    deleteConnection(sid).catch(e =>
                        console.error(`[BROADCAST] Failed to delete stale connection ${sid}: ${e.message}`)
                    )
                )
            );
        }
    }

    return { statusCode: 200, body: 'Broadcast complete' };
};