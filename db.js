// db.js
const mongoose = require('mongoose');

let cached = global.mongoose;
if (!cached) {
    cached = global.mongoose = { conn: null, promise: null };
}

async function connectDB() {
    if (cached.conn) {
        return cached.conn;
    }
    if (!cached.promise) {
        const opts = { bufferCommands: false }; // Disable buffering so it fails fast/clean if misconfigured
        cached.promise = mongoose.connect(process.env.MONGO_URI, opts).then((m) => m);
    }
    try {
        cached.conn = await cached.promise;
    } catch (e) {
        cached.promise = null;
        throw e;
    }
    return cached.conn;
}

module.exports = connectDB;