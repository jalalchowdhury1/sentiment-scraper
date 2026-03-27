/**
 * test-gemini.ts
 * Quick test to verify Gemini Flash API key works
 */
import "dotenv/config";
import { GoogleGenerativeAI } from "@google/generative-ai";

async function testGemini() {
    console.log("Testing Gemini Flash API...\n");

    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
        console.error("❌ No GOOGLE_API_KEY found in .env");
        return;
    }

    console.log(`✅ API Key found: ${apiKey.substring(0, 20)}...`);

    const genAI = new GoogleGenerativeAI(apiKey);

    try {
        // Use gemini-2.5-flash for vision (latest stable version for new users)
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        // Simple text test first
        console.log("\n📝 Testing text generation...");
        const textResult = await model.generateContent("Say 'Hello! Gemini Flash is working!' in exactly those words.");
        const textResponse = textResult.response;
        console.log(`✅ Text test passed: ${textResponse.text()}`);

        // Test vision with a simple base64 image (1x1 red pixel)
        console.log("\n📸 Testing vision capability...");
        const base64Image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

        const imagePart = {
            inlineData: {
                data: base64Image,
                mimeType: "image/png",
            },
        };

        const visionResult = await model.generateContent([
            "What color is this image? Just say the color name.",
            imagePart
        ]);

        const visionResponse = visionResult.response;
        console.log(`✅ Vision test passed: ${visionResponse.text()}`);
        console.log("\n🎉 Gemini Flash API is fully functional!");

    } catch (error: any) {
        console.error("\n❌ Gemini API test failed:");
        console.error(error.message);
        if (error.message?.includes("API_KEY")) {
            console.error("⚠️  Invalid API key or quota exceeded");
        }
    }
}

testGemini();
