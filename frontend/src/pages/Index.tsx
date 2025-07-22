
import { Shield, Lock, Users, FileText, ArrowRight, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useNavigate } from "react-router-dom";

const Index = () => {
  const navigate = useNavigate();

  const features = [
    {
      icon: Lock,
      title: "Private & Secure",
      description: "Your data never leaves your browser. Zero-knowledge cryptography ensures complete privacy."
    },
    {
      icon: Users,
      title: "Peer-to-Peer",
      description: "Direct connection between users. No servers store or process your sensitive information."
    },
    {
      icon: FileText,
      title: "Simple CSV Upload",
      description: "Just upload your CSV files. We'll handle the complex cryptographic protocols for you."
    }
  ];

  const steps = [
    "User A creates a session and uploads their dataset",
    "User A shares a secure link with User B", 
    "User B joins using the link and uploads their dataset",
    "Both users see only the overlapping items - nothing else"
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-green-50">
      {/* Header */}
      <header className="border-b bg-white/80 backdrop-blur-sm">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center">
                <Shield className="w-6 h-6 text-white" />
              </div>
              <h1 className="text-2xl font-bold text-gray-900">PSI Secure</h1>
            </div>
            <Button 
              onClick={() => navigate('/create')}
              className="bg-blue-600 hover:bg-blue-700"
            >
              Start Session
            </Button>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="py-20">
        <div className="container mx-auto px-4 text-center">
          <div className="max-w-4xl mx-auto">
            <h2 className="text-5xl font-bold text-gray-900 mb-6">
              Find Common Data
              <span className="text-blue-600 block">Without Sharing Everything</span>
            </h2>
            <p className="text-xl text-gray-600 mb-8 leading-relaxed">
              Private Set Intersection (PSI) lets you and another party discover shared items in your datasets 
              while keeping everything else completely private. No technical expertise required.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Button 
                size="lg" 
                onClick={() => navigate('/create')}
                className="bg-blue-600 hover:bg-blue-700 px-8 py-3 text-lg"
              >
                Create New Session
                <ArrowRight className="ml-2 w-5 h-5" />
              </Button>
              <Button 
                size="lg" 
                variant="outline"
                onClick={() => navigate('/join')}
                className="border-blue-600 text-blue-600 hover:bg-blue-50 px-8 py-3 text-lg"
              >
                Join Existing Session
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="py-16 bg-white">
        <div className="container mx-auto px-4">
          <div className="text-center mb-12">
            <h3 className="text-3xl font-bold text-gray-900 mb-4">How It Works</h3>
            <p className="text-lg text-gray-600">Four simple steps to secure data comparison</p>
          </div>
          <div className="max-w-4xl mx-auto">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              {steps.map((step, index) => (
                <div key={index} className="text-center">
                  <div className="w-12 h-12 bg-blue-600 text-white rounded-full flex items-center justify-center mx-auto mb-4 text-lg font-bold">
                    {index + 1}
                  </div>
                  <p className="text-gray-700 text-sm leading-relaxed">{step}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-16 bg-gray-50">
        <div className="container mx-auto px-4">
          <div className="text-center mb-12">
            <h3 className="text-3xl font-bold text-gray-900 mb-4">Why Choose PSI Secure?</h3>
            <p className="text-lg text-gray-600">Built with privacy and simplicity in mind</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-5xl mx-auto">
            {features.map((feature, index) => (
              <Card key={index} className="border-0 shadow-lg hover:shadow-xl transition-shadow duration-300">
                <CardContent className="p-6 text-center">
                  <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                    <feature.icon className="w-8 h-8 text-blue-600" />
                  </div>
                  <h4 className="text-xl font-semibold text-gray-900 mb-3">{feature.title}</h4>
                  <p className="text-gray-600 leading-relaxed">{feature.description}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* What is PSI */}
      <section className="py-16 bg-white">
        <div className="container mx-auto px-4">
          <div className="max-w-4xl mx-auto">
            <div className="text-center mb-12">
              <h3 className="text-3xl font-bold text-gray-900 mb-4">What is Private Set Intersection?</h3>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
              <div>
                <h4 className="text-xl font-semibold text-gray-900 mb-4">The Problem</h4>
                <p className="text-gray-600 mb-6 leading-relaxed">
                  You and another party both have datasets and want to find common items, but neither 
                  wants to reveal their complete list to the other. Traditional methods require sharing 
                  all your data, creating privacy risks.
                </p>
                <h4 className="text-xl font-semibold text-gray-900 mb-4">The Solution</h4>
                <p className="text-gray-600 leading-relaxed">
                  PSI uses advanced cryptography to compute intersections without revealing anything 
                  beyond the shared items. It's like having a secure, private comparison that shows 
                  only what you both have in common.
                </p>
              </div>
              <div className="bg-blue-50 p-8 rounded-xl">
                <h4 className="text-lg font-semibold text-gray-900 mb-4">Example Use Cases</h4>
                <div className="space-y-3">
                  <div className="flex items-start space-x-3">
                    <CheckCircle className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
                    <span className="text-gray-700 text-sm">Compare customer lists without sharing customer data</span>
                  </div>
                  <div className="flex items-start space-x-3">
                    <CheckCircle className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />  
                    <span className="text-gray-700 text-sm">Find mutual connections in professional networks</span>
                  </div>
                  <div className="flex items-start space-x-3">
                    <CheckCircle className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
                    <span className="text-gray-700 text-sm">Research collaboration without data sharing</span>
                  </div>
                  <div className="flex items-start space-x-3">
                    <CheckCircle className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
                    <span className="text-gray-700 text-sm">Security threat intelligence sharing</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-16 bg-blue-600">
        <div className="container mx-auto px-4 text-center">
          <h3 className="text-3xl font-bold text-white mb-4">Ready to Get Started?</h3>
          <p className="text-xl text-blue-100 mb-8">Create your first secure PSI session in seconds</p>
          <Button 
            size="lg"
            onClick={() => navigate('/create')}
            className="bg-white text-blue-600 hover:bg-blue-50 px-8 py-3 text-lg font-semibold"
          >
            Start Your Session Now
            <ArrowRight className="ml-2 w-5 h-5" />
          </Button>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-gray-900 text-gray-300 py-8">
        <div className="container mx-auto px-4">
          <div className="flex flex-col md:flex-row justify-between items-center">
            <div className="flex items-center space-x-3 mb-4 md:mb-0">
              <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
                <Shield className="w-5 h-5 text-white" />
              </div>
              <span className="text-lg font-semibold">PSI Secure</span>
            </div>
            <p className="text-sm text-gray-400">
              Secure Private Set Intersection • Privacy-First • No Data Storage
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default Index;
