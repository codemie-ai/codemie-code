import type { CodeMieClient, AboutUser, UserData } from "codemie-sdk";

export async function getUserProfile(
  client: CodeMieClient,
): Promise<AboutUser> {
  return client.users.aboutMe();
}

export async function getUserData(client: CodeMieClient): Promise<UserData> {
  return client.users.getData();
}
