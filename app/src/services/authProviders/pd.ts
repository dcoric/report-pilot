import { AuthProviderService } from "./index";
import { ProviderRow } from "../authProviderService";

export class PdAuthProviderService implements AuthProviderService {
  type = "pd" as const;

  async startLogin(provider: ProviderRow): Promise<{ authorizeUrl: string; flowState: any }> {
    // For PD (PingDirectory), typically follows LDAP/AD patterns
    // This is a placeholder implementation
    throw new Error("PD provider implementation not yet complete");
  }

  async completeLogin(provider: ProviderRow, currentUrl: string, flowState: any): Promise<any> {
    // Handle PD authentication
    // This is a placeholder implementation
    throw new Error("PD provider implementation not yet complete");
  }

  async testConnection(provider: ProviderRow): Promise<any> {
    // Test PD connection and authentication
    // This is a placeholder implementation
    throw new Error("PD provider implementation not yet complete");
  }

  buildPrincipal(claims: any): any {
    // Build external principal from PD attributes
    // This is a placeholder implementation
    throw new Error("PD provider implementation not yet complete");
  }
}