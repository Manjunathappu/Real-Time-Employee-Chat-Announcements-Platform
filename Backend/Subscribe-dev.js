'use strict';

/**
 * subscribe/index.js  —  WebSocket `subscribe` Action Handler
 *
 * Called by the client whenever an employee opens/switches to a channel.
 * This registers their active connectionId against the channelId so that
 * the sendMessage Lambda knows to push future messages to this connection.
 *
 * Route:   subscribe
 * Payload: { "action": "subscribe", "data": { "channelId": "general" } }
 *
 * Flow:
 *  1. Parse channelId from the event body
 *  2. Look up the employee's info from ConnectionsTable (set at $connect time)
 *  3. Write a subscription record to SubscriptionsTable
 *  4. Send a `subscribed` confirmation back to the client
 *
 * Note: A single connectionId can be subscribed to multiple channels.
 * On $disconnect, ALL subscriptions for the connection are batch-deleted.
 */

const { ApiGatewayManagementApiClient } = require('@aws-sdk/client-apigatewaymanagementapi');

const { getConnection, putSubscription } = require('/opt/nodejs/db');
const { getEndpoint, postToConnection, sendError } = require('/opt/nodejs/ws');

exports.handler = async (event) => {
    const connectionId = event.requestContext.connectionId;
    const endpoint     = getEndpoint(event.requestContext);

    console.log(`[SUBSCRIBE] connectionId=${connectionId}`);

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

    // --- 2. Fetch connection record (has employee info) ---
    let conn;
    try {
        conn = await getConnection(connectionId);
    } catch (err) {
        console.error(`[SUBSCRIBE] DynamoDB GetItem failed: ${err.message}`);
        await sendError(endpoint, connectionId, 'Internal error fetching connection');
        return { statusCode: 500, body: 'Internal error' };
    }

    if (!conn) {
        console.warn(`[SUBSCRIBE] No connection record found for ${connectionId}`);
        await sendError(endpoint, connectionId, 'Connection not registered — please reconnect');
        return { statusCode: 404, body: 'Connection not found' };
    }

    // --- 3. Upsert subscription record ---
    try {
        await putSubscription({
            channel_id:    channelId,
            connectionId,
            employee_id:   conn.employee_id.S,
            employee_name: conn.employee_name.S,
        });
        console.log(`[SUBSCRIBE] ${conn.employee_id.S} subscribed to ${channelId}`);
    } catch (err) {
        console.error(`[SUBSCRIBE] DynamoDB PutItem failed: ${err.message}`);
        await sendError(endpoint, connectionId, 'Failed to register subscription');
        return { statusCode: 500, body: 'DynamoDB error' };
    }

    // --- 4. Confirm subscription back to client ---
    const apigw = new ApiGatewayManagementApiClient({ endpoint });
    await postToConnection(apigw, connectionId, {
        action: 'subscribed',
        data:   { channelId, success: true },
    });

    return { statusCode: 200, body: 'Subscribed' };
};