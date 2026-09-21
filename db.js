const mongoose = require('mongoose');

let cached = global.mongoose;
if (!cached) {
    cached = global.mongoose = { conn: null, promise: null };
}

async function connectDB() {
    if (cached.conn) {
        return cached.conn;
    }

    if (!process.env.MONGO_URI) {
        throw new Error('Please define the MONGO_URI environment variable inside .env');
    }

    if (!cached.promise) {
        const opts = { bufferCommands: false };
        cached.promise = mongoose.connect(process.env.MONGO_URI, opts).then((mongooseInstance) => {
            return mongooseInstance;
        });
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