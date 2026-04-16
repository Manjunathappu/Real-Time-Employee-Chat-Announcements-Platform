'use strict';

/**
 * connect/index.js  —  WebSocket $connect Handler
 *
 * Triggered when a client opens a WebSocket connection.
 * Route: $connect (wss://...?token=<CognitoJWT>)
 *
 * Flow:
 *  1. Extract JWT from query string parameter `token`
 *  2. Verify the JWT against the Cognito JWKS endpoint
 *  3. Store the connection record in DynamoDB (ConnectionsTable) with 24h TTL
 *  4. Return 200 to allow the connection (any non-200 rejects it)
 *
 * Security note: Returning a non-2xx status here will close the WebSocket
 * handshake before it is established — effectively blocking the client.
 */

const { verifyToken }  = require('/opt/nodejs/auth');
const { putConnection, getAllConnections } = require('/opt/nodejs/db');
const { broadcastToConnections } = require('/opt/nodejs/ws');

const APIGW_ENDPOINT = process.env.WEBSOCKET_API_ENDPOINT;

exports.handler = async (event) => {
    const connectionId = event.requestContext.connectionId;
    const token        = event.queryStringParameters?.token;

    console.log(`[CONNECT] connectionId=${connectionId}`);

    // --- 1. Reject if no token provided ---
    if (!token) {
        console.warn('[CONNECT] Rejected: no token in query string');
        return { statusCode: 401, body: 'Unauthorized: missing token' };
    }

    // --- 2. Verify the Cognito JWT ---
    let employee;
    try {
        employee = await verifyToken(token);
        console.log(`[CONNECT] Token verified for sub=${employee.sub}`);
    } catch (err) {
        console.error(`[CONNECT] Token verification failed: ${err.message}`);
        return { statusCode: 401, body: `Unauthorized: ${err.message}` };
    }

    // --- 3. Persist the connection in DynamoDB ---
    try {
        await putConnection({
            connectionId,
            employee_id:    employee.sub,
            employee_name:  employee.name  || employee.email?.split('@')[0] || 'Employee',
            employee_email: employee.email || '',
            department:     employee['custom:department'] || 'General',
        });
        console.log(`[CONNECT] Stored connection for employee=${employee.sub}`);

        // --- 4. Broadcast 'online' presence to everyone else ---
        // This fires and forgets to keep $connect performance snappy
        (async () => {
            try {
                const connections = await getAllConnections();
                const otherConnIds = connections
                    .map(c => c.connectionId.S)
                    .filter(cid => cid !== connectionId);

                if (otherConnIds.length > 0) {
                    await broadcastToConnections(APIGW_ENDPOINT, otherConnIds, {
                        action: 'presence',
                        data: { userId: employee.sub, status: 'online' }
                    });
                    console.log(`[CONNECT] Broadcast presence for ${employee.sub} to ${otherConnIds.length} users`);
                }
            } catch (err) {
                console.error(`[CONNECT] Presence broadcast failed: ${err.message}`);
            }
        })();
    } catch (err) {
        console.error(`[CONNECT] DynamoDB write failed: ${err.message}`);
        // Still allow the connection — client will work but history may be missing
        // In production you may want to return 500 here
    }

    // --- 4. Connection accepted ---
    return { statusCode: 200, body: 'Connected' };
};