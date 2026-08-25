import { closeMainWindow, showToast, Toast } from "@vicinae/api";
import { execSync } from "node:child_process";

function callBarIpc(action: "toggle" | "show" | "hide") {
	execSync(`qs ipc call bar ${action}`);
}

export default async function ToggleBar() {
	try {
		callBarIpc("toggle");
		await showToast({
			title: "Toggled bar visibility",
			style: Toast.Style.Success,
		});
	} catch (error) {
		await showToast({
			title: "Failed to toggle bar",
			message: error instanceof Error ? error.message : String(error),
			style: Toast.Style.Failure,
		});
	}

	await closeMainWindow();
}
