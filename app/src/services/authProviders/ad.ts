import { AuthProviderService } from "./index";
import { ProviderRow } from "../authProviderService";

export class AdAuthProviderService implements AuthProviderService {
  type = "ad" as const;

  async startLogin(provider: ProviderRow): Promise<{ authorizeUrl: string; flowState: any }> {
    // For AD, typically uses LDAP with Windows authentication
    // This is a placeholder implementation
    throw new Error("AD provider implementation not yet complete");
  }

  async completeLogin(provider: ProviderRow, currentUrl: string, flowState: any): Promise<any> {
    // Handle AD authentication
    // This is a placeholder implementation
    throw new Error("AD provider implementation not yet complete");
  }

  async testConnection(provider: ProviderRow): Promise<any> {
    // Test AD connection and authentication
    // This is a placeholder implementation
    throw new Error("AD provider implementation not yet complete");
  }

  buildPrincipal(claims: any): any {
    // Build external principal from AD attributes
    // This is a placeholder implementation
    throw new Error("AD provider implementation not yet complete");
  }
}