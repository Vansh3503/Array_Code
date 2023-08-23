#include <iostream>
#include <algorithm>
using namespace std;
int main() {
   int arr[]={2,3,1,7,9,0};
   int size=sizeof(arr)/sizeof(arr[0]);
   int k;
   cin>>k;
   int sum=0;
   for(int i=0;i<size;i++)
   {
      
       for(int j=i+1;j<size;j++)
       {
           if(arr[i]+arr[j]==k)
           {
               cout<<i;
               cout<<j;
           }
       }
   }
}
