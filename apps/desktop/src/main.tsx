import ReactDOM from "react-dom/client";
import App from "./App";
import "./App.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Starfire root element was not found.");
}

ReactDOM.createRoot(root).render(<App />);
