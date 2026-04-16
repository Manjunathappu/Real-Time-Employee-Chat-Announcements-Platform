'use strict';

/**
 * disconnect/index.js  —  WebSocket $disconnect Handler
 *
 * Triggered automatically when a WebSocket connection is closed
 * (browser tab closed, logout, network drop, idle timeout, etc.)
 *
 * Route: $disconnect
 *
 * Flow:
 *  1. Delete the connection record from ConnectionsTable
 *  2. Query SubscriptionsTable via ConnectionIdIndex GSI to find all
 *     channel subscriptions belonging to this connection
 *  3. Batch-delete all subscription records
 *
 * DynamoDB TTL will also clean these up eventually (24h), but explicit
 * deletion keeps the subscription table accurate for online users.
 */

const {
    getConnection,
    deleteConnection,
    deleteConnectionSubscriptions,
    getAllConnections,
} = require('/opt/nodejs/db');
const { broadcastToConnections } = require('/opt/nodejs/ws');

const APIGW_ENDPOINT = process.env.WEBSOCKET_API_ENDPOINT;

exports.handler = async (event) => {
    const connectionId = event.requestContext.connectionId;

    console.log(`[DISCONNECT] connectionId=${connectionId}`);

    // --- 1. Fetch connection info before deletion to get employee_id ---
    let employeeId;
    try {
        const conn = await getConnection(connectionId);
        if (conn) employeeId = conn.employee_id.S;
    } catch (err) {
        console.error(`[DISCONNECT] Failed to fetch connection details: ${err.message}`);
    }

    // --- 2. Run both deletions in parallel for speed ---
    await Promise.allSettled([
        deleteConnection(connectionId)
            .then(() => console.log(`[DISCONNECT] Removed connection record: ${connectionId}`))
            .catch(err => console.error(`[DISCONNECT] Failed to delete connection: ${err.message}`)),

        deleteConnectionSubscriptions(connectionId)
            .then(() => console.log(`[DISCONNECT] Cleaned up subscriptions for: ${connectionId}`))
            .catch(err => console.error(`[DISCONNECT] Failed to delete subscriptions: ${err.message}`)),
    ]);

    // --- 3. Broadcast 'offline' presence (if we found the employeeId) ---
    if (employeeId) {
        try {
            const connections = await getAllConnections();
            const otherConnIds = connections.map(c => c.connectionId.S);

            if (otherConnIds.length > 0) {
                await broadcastToConnections(APIGW_ENDPOINT, otherConnIds, {
                    action: 'presence',
                    data: { userId: employeeId, status: 'offline' }
                });
                console.log(`[DISCONNECT] Broadcast logout for ${employeeId} to ${otherConnIds.length} users`);
            }
        } catch (err) {
            console.error(`[DISCONNECT] Logout broadcast failed: ${err.message}`);
        }
    }

    return { statusCode: 200, body: 'Disconnected' };
};