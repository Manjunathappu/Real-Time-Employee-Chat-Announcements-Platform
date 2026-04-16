'use strict';

/**
 * getHistory/index.js  —  WebSocket `getHistory` Action Handler
 *
 * Returns the last 50 messages for a channel, delivered directly back
 * to the requesting connection via the API Gateway Management API.
 *
 * Route:   getHistory
 * Payload: { "action": "getHistory", "data": { "channelId": "general" } }
 *
 * Response (pushed to client):
 * {
 *   "action": "historyLoaded",
 *   "data": {
 *     "channelId": "general",
 *     "messages":  [ ...array of message objects, chronological order... ]
 *   }
 * }
 *
 * Flow:
 *  1. Parse channelId from the event body
 *  2. Query MessagesTable with ScanIndexForward=false + Limit=50 (newest first)
 *  3. Reverse results back to chronological order
 *  4. Push the history payload directly to the requesting connection
 *
 * Cap at 50 messages per channel to stay within DynamoDB free-tier read units.
 * (50 items * ~1KB each = 50 RCUs per getHistory call)
 */

const { ApiGatewayManagementApiClient } = require('@aws-sdk/client-apigatewaymanagementapi');

const { getChannelHistory }                     = require('/opt/nodejs/db');
const { getEndpoint, postToConnection, sendError } = require('/opt/nodejs/ws');

const HISTORY_LIMIT = 50;

exports.handler = async (event) => {
    const connectionId = event.requestContext.connectionId;
    const endpoint     = getEndpoint(event.requestContext);

    console.log(`[GET_HISTORY] connectionId=${connectionId}`);

    // --- 1. Parse payload ---
    let body;
    try {
        body = JSON.parse(event.body || '{}');
    } catch {
        await sendError(endpoint, connectionId, 'Invalid JSON body');
        return { statusCode: 400, body: 'Bad request' };
    }

    const channelId = body?.data?.channelId || body?.channelId;

    if (!channelId || typeof channelId !== 'string') {
        await sendError(endpoint, connectionId, 'Missing required field: channelId');
        return { statusCode: 400, body: 'channelId required' };
    }

    // --- 2. Query message history ---
    let messages;
    try {
        messages = await getChannelHistory(channelId, HISTORY_LIMIT);
        console.log(`[GET_HISTORY] Fetched ${messages.length} messages for ${channelId}`);
    } catch (err) {
        console.error(`[GET_HISTORY] DynamoDB Query error: ${err.message}`);
        await sendError(endpoint, connectionId, 'Failed to fetch message history');
        return { statusCode: 500, body: 'History query failed' };
    }

    // --- 3. Push history to the requesting connection ---
    const apigw = new ApiGatewayManagementApiClient({ endpoint });

    const ok = await postToConnection(apigw, connectionId, {
        action: 'historyLoaded',
        data: {
            channelId,
            messages,
            count:   messages.length,
            capped:  messages.length === HISTORY_LIMIT,
        },
    });

    if (!ok) {
        console.warn(`[GET_HISTORY] Connection ${connectionId} already gone before history could be delivered`);
    }

    return { statusCode: 200, body: 'History delivered' };
};