'use strict';

/**
 * getUsers/index.js  —  WebSocket `getUsers` Action Handler
 *
 * Fetches the list of all employees from the Cognito User Pool.
 *
 * Route:   getUsers
 * Payload: { "action": "getUsers" }
 */

const { CognitoIdentityProviderClient, ListUsersCommand } = require('@aws-sdk/client-cognito-identity-provider');
const { ApiGatewayManagementApiClient } = require('@aws-sdk/client-apigatewaymanagementapi');
const { getEndpoint, postToConnection } = require('/opt/nodejs/ws');
const { getAllConnections } = require('/opt/nodejs/db');

const cognito = new CognitoIdentityProviderClient({});

exports.handler = async (event) => {
    // Safety check for requestContext (required for WebSocket actions)
    if (!event || !event.requestContext) {
        console.error('[GET_USERS] Missing event.requestContext. Event:', JSON.stringify(event));
        return { statusCode: 400, body: 'Bad Request: Missing requestContext' };
    }

    const connectionId = event.requestContext.connectionId;
    const endpoint     = getEndpoint(event.requestContext);
    const apigw        = new ApiGatewayManagementApiClient({ endpoint });

    const userPoolId = process.env.COGNITO_USER_POOL_ID;

    if (!userPoolId) {
        console.error('[GET_USERS] Missing COGNITO_USER_POOL_ID env var');
        return { statusCode: 500, body: 'Configuration error' };
    }

    try {
        console.log(`[GET_USERS] Fetching users from User Pool: ${userPoolId}`);
        
        // --- 1. Fetch all users from Cognito ---
        const cognitoCommand = new ListUsersCommand({
            UserPoolId: userPoolId,
            AttributesToGet: ['sub', 'name', 'custom:department']
        });
        const cognitoResponse = await cognito.send(cognitoCommand);

        // --- 2. Fetch all active connections from DynamoDB ---
        let activeEmployeeIds = new Set();
        try {
            const connections = await getAllConnections();
            activeEmployeeIds = new Set(connections.map(c => c.employee_id.S));
            console.log(`[GET_USERS] Found ${activeEmployeeIds.size} unique online employees`);
        } catch (dbErr) {
            console.error('[GET_USERS] Failed to fetch active connections:', dbErr.message);
            // Fallback: everyone is offline
        }

        // --- 3. Map and Augment with Presence ---
        const usersList = cognitoResponse.Users.map(user => {
            const attr = {};
            if (user.Attributes) {
                user.Attributes.forEach(a => attr[a.Name] = a.Value);
            }
            const id = attr.sub || user.Username;
            return {
                id:         id,
                name:       attr.name || user.Username,
                department: attr['custom:department'] || 'General',
                isOnline:   activeEmployeeIds.has(id)
            };
        });

        console.log(`[GET_USERS] Found ${usersList.length} users. Sending to connection ${connectionId}`);

        await postToConnection(apigw, connectionId, {
            action: 'usersList',
            data:   { usersList }
        });

        return { statusCode: 200, body: 'Users list sent' };
    } catch (err) {
        console.error('[GET_USERS] Error:', err);
        return { statusCode: 500, body: `Error: ${err.message}` };
    }
};