const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    username: { type: String, required: true },
    avatar: { type: String },
    whitelistStatus: { type: String, default: 'Pending' }, // Match your form's 'Pending' status
    department: { type: String, default: 'Unassigned' },
    callsign: { type: String, default: 'Unassigned' },
    strikes: { type: Number, default: 0 },
    submittedDate: { type: String },
    lastActive: { type: Date, default: Date.now },
    
    // Updated Form Fields matching your HTML names:
    irl_name: { type: String },
    irl_age_bday: { type: String },
    rp_name: { type: String },
    rp_age: { type: Number },
    rp_address: { type: String },
    rp_description: { type: String },
    rp_story: { type: String },
    joined_rp: { type: String },
    fivem_time: { type: String },
    previous_servers: { type: String },
    about_yourself: { type: String },
    interests: { type: [String] } // Array since checkboxes can submit multiple values
});

module.exports = mongoose.model('User', userSchema);