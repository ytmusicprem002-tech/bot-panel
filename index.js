const express = require("express");
const app = express();

// biar bisa menerima request dari panel.php di InfinityFree
const cors = require("cors");
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// contoh endpoint test
app.get("/", (req, res) => {
  res.send("Runner Deployra aktif 🚀");
});

// endpoint upload script
app.post("/api/upload", (req, res) => {
  res.json({ success: true, message: "Upload berhasil!" });
});

// port otomatis dari Deployra
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server jalan di port " + PORT));
