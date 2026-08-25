import { closeMainWindow, showToast, Toast } from "@vicinae/api";
import { execSync } from "node:child_process";

export default async function HideBar() {
	try {
		execSync("qs ipc call bar hide");
		await showToast({
			title: "Bar hidden",
			style: Toast.Style.Success,
		});
	} catch (error) {
		await showToast({
			title: "Failed to hide bar",
			message: error instanceof Error ? error.message : String(error),
			style: Toast.Style.Failure,
		});
	}

	await closeMainWindow();
}
