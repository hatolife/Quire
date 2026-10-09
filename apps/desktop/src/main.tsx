import { render } from "solid-js/web";
import App from "./App";
import DetachedPane from "./layout/DetachedPane";
import "./style.css";

render(() => new URLSearchParams(window.location.search).has("pane") ? <DetachedPane /> : <App />, document.getElementById("root")!);
