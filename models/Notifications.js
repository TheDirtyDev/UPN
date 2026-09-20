const mongoose = require('mongoose'); 
const notificationSchema = new mongoose.Schema({ title: { type: String, required: true }, message: { type: String, required: true }, type: { type: String, default: 'info' }, targetUser: { type: String, default: null }, createdBy: { type: String, required: true }, createdAt: { type: Date, default: Date.now } }); 
module.exports = mongoose.model('Notification', notificationSchema); 
