import { closeMainWindow, showToast, Toast } from "@vicinae/api";
import { execSync } from "node:child_process";

export default async function ShowBar() {
	try {
		execSync("qs ipc call bar show");
		await showToast({
			title: "Bar shown",
			style: Toast.Style.Success,
		});
	} catch (error) {
		await showToast({
			title: "Failed to show bar",
			message: error instanceof Error ? error.message : String(error),
			style: Toast.Style.Failure,
		});
	}

	await closeMainWindow();
}
