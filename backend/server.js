const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = 3000;

app.use(bodyParser.json());
app.use(cors());

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URL, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB connected...'))
  .catch(err => console.log(err));

// Create a schema for the reservations
const reservationSchema = new mongoose.Schema({
  name: String,
  email: String,
  phone: String,
  date: String,
  time: String,
  guests: Number,
});

// Create a model from the schema
const Reservation = mongoose.model('Reservation', reservationSchema);

// API endpoint to get all reservations
app.get('/', async (req, res) => {
  try {
    const reservations = await Reservation.find();
    res.status(200).send(reservations);
  } catch (err) {
    res.status(500).send('Error fetching reservations.');
  }
});

// API endpoint to create a new reservation
app.post('/', async (req, res) => {
  console.log('POST request received at /api');
  try {
    const newReservation = new Reservation(req.body);
    await newReservation.save();
    res.status(201).send({ message: 'Reservation created successfully!', reservation: newReservation });
  } catch (err) {
    res.status(500).send('Error saving reservation.');
  }
});

module.exports = app;