const functions = require('firebase-functions')
const admin = require('firebase-admin')
const cors = require('cors')({ origin: true })
// Put this line to your function
// Automatically allow cross-origin requests
// cors(req, res, () => {})

const axios = require('axios')
const Firestore = require('@google-cloud/firestore')
admin.initializeApp(functions.config().firebase)

const firestore = new Firestore({
  projectId: 'shoppin-all',
  timestampsInSnapshots: true,
})

const updateClaims = (uid) => {
  return firestore.collection('claims').doc(uid).set({
    _forceRefresh: null,
    'x-hasura-default-role': 'lite_user',
    isOnboarded: false,
  })
}

exports.processSignUp = functions.auth.user().onCreate((user) => {
  // Build a reference to their per-user document in the
  // users collection
  const hasuraAdminSecret = 'x123'

  const runSQL = {
    type: 'run_sql',
    args: {
      sql: `INSERT INTO accounts (uid, email) VALUES ('${user.uid}', '${user.email}') ON CONFLICT (uid) DO NOTHING`,
    },
  }

  const headers = {
    'Content-Type': 'application/json',
    'x-hasura-admin-secret': hasuraAdminSecret,
  }

  axios
    .post('https://hasura.buildthat.xyz/v1/query', JSON.stringify(runSQL), {
      headers,
    })
    .then((result) => {
      console.log(result.data)
      return result.data
    })
    .catch((err) => {
      console.log(err)
    })

  return updateClaims(user.uid)
})

exports.authOnDelete = functions.auth.user().onDelete(async (user) => {
  console.log(`Deleting document for user ${user.uid}`)

  await firestore.collection('claims').doc(user.uid).delete()
})

exports.reception = functions.https.onRequest((req, res) => {
  cors(req, res, () => {})
  if (req.method !== 'POST') {
    return res.status(400).send('Please send a POST request')
  }

  const hasuraAdminSecret = 'hu57l3h4ck3r88'
  const { uid } = req.body

  const runSQL = {
    type: 'run_sql',
    args: {
      sql: `SELECT is_onboarded FROM accounts WHERE uid = '${uid}'`,
    },
  }

  const headers = {
    'Content-Type': 'application/json',
    'x-hasura-admin-secret': hasuraAdminSecret,
  }

  axios
    .post('https://hasura.buildthat.xyz/v1/query', JSON.stringify(runSQL), {
      headers,
    })
    .then((r) => {
      //console.log('lop', result.data)

      const isOnboarded = r.data.result[0][1] === 'f' ? false : true
      return res.status(200).send({ isOnboarded })
    })
    .catch((err) => {
      console.log(err)
      return
    })
})

exports.refreshToken = functions.https.onRequest((req, res) => {
  console.log('TOKEN REFRESH', req.query.uid)
  cors(req, res, () => {
    updateClaims(req.query.uid)
      .then(() => {
        return res.status(200).send('success')
      })
      .catch((error) => {
        console.error('REFRESH ERROR', error)
        return res.status(400).send(error)
      })
  })
})

exports.mirrorCustomClaims = functions.firestore
  .document('claims/{uid}')
  .onWrite(async (change, context) => {
    const uid = context.params.uid
    const beforeData = change.before.data() || {}
    const afterData = change.after.data() || {}
    // Skip updates where _lastCommitted field changed,
    // to avoid infinite loops
    const skipUpdate =
      beforeData._lastCommitted &&
      afterData._lastCommitted &&
      !beforeData._lastCommitted.isEqual(afterData._lastCommitted)
    if (skipUpdate) {
      console.log('Update skipped with no changes')
      return
    }

    // Reset forceRefresh flag
    if (
      beforeData._forceRefresh === true &&
      afterData._forceRefresh === false
    ) {
      try {
        console.log('Resetting forceRefresh flag')
        await change.after.ref.update({
          _forceRefresh: false,
        })
      } catch (error) {
        console.error('Error occured. ', error)
      }
      return
    }

    // Create a new JSON payload and check_firstCommitted === null ? updateTime : _firstCommitted that it's under
    // the 1000 character max console.log('forceRefresh flag resetted')
    const {
      _lastCommitted,
      _forceRefresh,
      isOnboarded,
      ...newClaims
    } = afterData

    const defaultClaims = {
      'x-hasura-default-role': 'lite_user',
      'x-hasura-allowed-roles': ['lite_user', 'basic_user', 'pro_user'],
      'x-hasura-user-id': uid,
    }

    const updatedClaims = {
      'https://hasura.io/jwt/claims': {
        ...defaultClaims,
        ...newClaims,
      },
      isOnboarded,
    }

    console.log(`Setting custom claims for ${uid}`, updatedClaims)
    await admin.auth().setCustomUserClaims(uid, updatedClaims)
    console.log('Updating document timestamp')
    await change.after.ref.update({
      _lastCommitted:
        beforeData._lastCommitted === undefined
          ? null
          : admin.firestore.FieldValue.serverTimestamp(),
      _forceRefresh,
      isOnboarded, //newClaims.isOnboarded,
      ...newClaims,
    })
  })
