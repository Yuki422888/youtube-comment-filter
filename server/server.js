import express from "express";
import cors from "cors";

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ message: "Server is running" });
});

app.post("/analyze", (req, res) => {
  const { text } = req.body;

  let score = 0.1;

  if (text.includes("死ね")) score = 0.95;
  if (text.includes("バカ")) score = 0.85;

  res.json({ score });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
