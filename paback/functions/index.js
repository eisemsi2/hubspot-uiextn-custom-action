const functions = require('firebase-functions');
const admin = require('firebase-admin');
const express = require('express');
const request = require('request-promise-native');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const { error } = require('firebase-functions/logger');
const cors = require('cors')({ origin: true, credentials: true });


admin.initializeApp();
const db = admin.firestore();

const app = express();
app.use(cookieParser());
app.use(express.json()); // Add JSON body parser
app.use(cors);
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "https://app.hubspot.com");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});


const CLIENT_ID = '5f2ab493-d9f9-4fb4-83d7-26fa8a6b3bb7';
const CLIENT_SECRET = 'b1a74dac-18dc-4cbf-8454-0f2d258c4591';
const REDIRECT_URI = 'https://us-central1-hubspot-fetch.cloudfunctions.net/app/oauth-callback';
const DEVELOPER_API_KEY = '69109a98-20b4-4a21-bfaf-91a8ea4c9ef0';
const APP_ID = '7546401';

const SCOPES = ["crm.objects.contacts.read", "crm.objects.contacts.write", "crm.schemas.companies.read","crm.objects.companies.read", "crm.objects.companies.write", "crm.objects.deals.read", "crm.objects.deals.write", "automation", "oauth"].join(' ');

// Middleware to check authentication state
const checkAuth = async (req, res, next) => {
  const state = req.cookies.state;
  if (!state) return res.redirect('/install');
  
  const sessionDoc = await db.collection('sessions').doc(state).get();
  if (!sessionDoc.exists || !sessionDoc.data().refreshToken) {
    res.clearCookie('state');
    return res.redirect('/install');
  }
  
  req.session = sessionDoc.data();
  req.state = state;
  next();
};

app.get('/install', async (req, res) => {
  try {
    const state = uuidv4(); // Generates a valid UUID
    // Validate state before using
    if (typeof state !== 'string' || state.length === 0) {
      throw new Error('Invalid state generated');
    }

    await db.collection('sessions').doc(state).set({
      createdAt: Date.now(),
      status: 'initiated'
    });
    console.log('state', state);
    res.cookie('state', state, { 
      httpOnly: true,
      secure: true, // Required for HTTPS
      sameSite: 'None', // Required for cross-site cookies
      maxAge: 600000 // 10 minutes
    });

    const authUrl = 
      `https://app.hubspot.com/oauth/authorize?client_id=${encodeURIComponent(CLIENT_ID)}` +
      `&scope=${encodeURIComponent(SCOPES)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&state=${state}`;
    console.log(authUrl);
    res.redirect(authUrl);
  } catch (error) {
    res.redirect(`/error?msg=${encodeURIComponent(error.message)}`);
  }
});

app.get('/oauth-callback', async (req, res) => {
  const {code, state} = req.query;
  console.log('state', state);
  const sessionRef = db.collection('sessions').doc(state);
  if (!code || !state) {
    return res.redirect('/error?msg=Missing authorization code or state');
  }
  
  try {
    const tokens = await exchangeForTokens(state, {
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code
    });
    
    const accountdetails = await request.get('https://api.hubapi.com/account-info/v3/details', {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        'Content-Type': 'application/json'
      },
      json: true
    });
    const { portalId } = accountdetails;


    await sessionRef.update({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expires_in * 1000),
      portalId: portalId
    });

    res.cookie('state', state, { httpOnly: true });
    res.redirect('/app/auth-success');
  } catch (error) {
    res.redirect(`/error?msg=${error.message}`);
  }
});

app.get('/auth-success', checkAuth, async (req, res) => {
  try {
    let { accessToken, expiresAt } = req.session;
    if (Date.now() >= expiresAt) {
      accessToken = await refreshAccessToken(req.state);
    }

    const contact = await getContact(accessToken);
    res.send(`
      <h2>HubSpot OAuth 2.0 Success </h2>
      <p>Access Token: ${accessToken}</p>
      <p>Contact: ${contact.properties.firstname.value} ${contact.properties.lastname.value}</p>
    `);
  } catch (error) {
    res.redirect(`/error?msg=${error.message}`);
  }
});

app.get('/error', (req, res) => {
  res.status(400).send(`<h4>Error: ${req.query.msg}</h4>`);
});

// Token management
async function exchangeForTokens(state, exchangeProof) {
  try {
    const response = await request.post('https://api.hubapi.com/oauth/v1/token', {
      form: exchangeProof,
      json: true
    });

    return response;
  } catch (error) {
    throw new Error(error.error.message);
  }
}

async function refreshAccessToken(state) {
  const sessionRef = db.collection('sessions').doc(state);
  const sessionDoc = await sessionRef.get();
  const { refreshToken } = sessionDoc.data();

  const tokens = await exchangeForTokens(state, {
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
  });

  await sessionRef.update({
    accessToken: tokens.access_token,
    expiresAt: Date.now() + (tokens.expires_in * 1000),
  });

  return tokens.access_token;
}

/**
 * Retrieves an access token for the specified portal ID. If the token is expired, it refreshes the token.
 *
 * @param {number|string} portalId - The ID of the portal to retrieve the access token for.
 * @returns {Promise<string>} - A promise that resolves to the access token.
 * @throws {Error} - Throws an error if the portal ID is not found or if there is an issue with token exchange.
 */
async function getAccessToken(portalId) {
  portalId = Number(portalId);
  const sessionQuery = await db.collection("sessions")
    .where("portalId", "==", portalId || "")
    .limit(1)
    .get();

  if (sessionQuery.empty) {
    return res.status(401).json({ error: "No such portal" });
  }

  const sessionDoc = sessionQuery.docs[0];
  const sessionData = sessionDoc.data();
  let { accessToken, expiresAt, refreshToken } = sessionData;


  if (Date.now() >= expiresAt) {
    console.log("Token expired. Refreshing...");
    const tokens = await exchangeForTokens(sessionDoc.id, {
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
    });

    accessToken = tokens.access_token;
    expiresAt = Date.now() + tokens.expires_in * 1000;

    // 🔹 Update Firestore with new token
    await sessionDoc.ref.update({ accessToken, expiresAt });
  }

  return accessToken;
}

// HubSpot API client
async function getContact(accessToken) {
  try {
    const response = await request.get(
      'https://api.hubapi.com/contacts/v1/lists/all/contacts/all?count=1',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        json: true
      }
    );
    return response.contacts[0];
  } catch (error) {
    throw new Error('Failed to fetch contact');
  }
}

// Get contacts with authentication and token check
app.get('/companies', async (req, res) => {
  try {
    let {portalId} = req.query
    const accessToken = await getAccessToken(portalId);

    const response = await request.get('https://api.hubapi.com/crm/v3/objects/companies?properties=name', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      json: true
    });
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get associations with authentication and token check
app.get('/associations/:contactId', async (req, res) => {
  try {
    let {portalId} = req.query
    const accessToken = await getAccessToken(portalId);

    const response = await request.get(
      `https://api.hubapi.com/crm/v4/objects/contacts/${req.params.contactId}/associations/companies`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        json: true
      }
    );
    res.json(response.results);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

//  Save associations on HubSpot
app.post('/save-associations', async (req, res) => {
  try {
    let {portalId} = req.query
    const accessToken = await getAccessToken(portalId);
    const { contactId, companyIds } = req.body;
    const batchRequests = companyIds.map(companyId => ({
        from: { id: contactId },
        to: { id: companyId },
        types: [
          {
            "associationCategory": "HUBSPOT_DEFINED",
            "associationTypeId": 279
          }
        ]
    }));
    const response = await request.post('https://api.hubapi.com/crm/v4/associations/contacts/companies/batch/create', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      json: true,
      body: { inputs: batchRequests }
    });
    console.log(response);  
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// add callbackid to firestore
app.post('/addCallback', async (req, res) => {
  try {
    const {origin:{portalId}, object: {objectId}, callbackId } = req.body;

    await db.collection('callbacks').doc(callbackId).set({
      portalId: portalId,
      objectId: objectId
    });

    res.json({ status: 'success' });
  }catch(error){
    console.log(error);
    res.status(500).json({ error: error.message });
  }
});

// Retry Deal Custom Action from callbackId
app.post('/retryDeal/:callbackId', async (req,res) => {
  try{
    const callbackId = req.params.callbackId;
    const doc = await db.collection('callbacks')
      .doc(callbackId).get();
    if (!doc.exists) {
      throw new error("Invalid Callback Id");
    }

    const docData = doc.data();
    const {portalId, objectId} = docData;
    // res.json({"portalId": portalId,
    //   "objectId": objectId
    // });
    const accessToken = await getAccessToken(portalId);
    // res.json({"accessToken": accessToken});

    const dealresponse = await request.get(`https://api.hubapi.com/crm/v3/objects/deals/${objectId}?properties=number_tried`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      json: true
    });
    let number_tried = Number(dealresponse.properties.number_tried);
    if (number_tried === undefined || number_tried === null || number_tried === NaN) {
      number_tried = 0;
    }
    const data = {
      "properties": {
        "dealstage": "qualifiedtobuy",
        "number_tried": number_tried+1
      }
    }
    const hubResponse = await request.patch(`https://api.hubapi.com/crm/v3/objects/deals/${objectId}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      json: true,
      body: data
    });

    // res.json(hubResponse);

    const response = await request.post(`https://api.hubapi.com/automation/v4/actions/callbacks/${callbackId}/complete`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      json: true,
      body: {
        "outputFields": {
          "hs_execution_state": "SUCCESS"
        }
      }
    });
    res.send(200).json(response.json());
  }catch{
    res.send(500).json({ error: error.message });
  }
});

// To register custom action on hubspot 
app.get('/registerCustomAction', async (req, res) => {
  try {
    const data = {
      "actionUrl": "https://us-central1-hubspot-fetch.cloudfunctions.net/app/addCallback",
      "published": true,
      "outputFields": [],
      "labels": {
          "en": {
              "actionName": "Retry Deal Custom Action"
          }
      },
      "objectTypes": ["DEAL"],
      "fuctionType": "POST_ACTION_EXECUTION",
      "functionSource": "exports.main = (event, callback) => {\\r\\n  callback({\\r\\n    \\\"outputFields\\\": {\\r\\n      \\\"hs_execution_state\\\": \\\"BLOCK\\\",\\r\\n      \\\"hs_expiration_duration\\\": \\\"P7DT12H\\\"\\r\\n    }\\r\\n  });\\r\\n}"
    }
    const response = await request.post(`https://api.hubapi.com/automation/v4/actions/${APP_ID}?hapikey=${DEVELOPER_API_KEY}`, {
      headers: {
        'Content-Type': 'application/json'
      },
      json: true,
      body: data
    })

    return res.status(200);
  } catch (error) {
    res.status(500).json({ error: error });
  }
});


exports.app = functions.https.onRequest(app);