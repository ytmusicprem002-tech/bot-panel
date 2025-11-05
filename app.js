const express = require("express");
const cors = require("cors");
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.send("Runner Deployra aktif 🚀 (versi app.js)");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server aktif di port " + PORT));
